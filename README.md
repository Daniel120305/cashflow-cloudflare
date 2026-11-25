# CashFlow na Cloudflare

Versão do CashFlow para rodar na **Cloudflare Workers**, no lugar do Render.
Usa o **mesmo banco Supabase**: nenhum dado precisa ser copiado, e o site antigo
no Render pode continuar no ar durante a troca.

## Por que fica mais rápido

| | Render (antes) | Cloudflare (agora) |
|---|---|---|
| Onde roda | EUA | São Paulo, ao lado do Supabase |
| Primeiro acesso depois de um tempo parado | 30 a 50 s (o servidor "dorme") | imediato (não dorme) |
| Páginas, CSS e JS | saem dos EUA | saem da rede da Cloudflare, perto de quem acessa |
| Conexão com o banco | abre conexões cruzando o continente | Hyperdrive mantém conexões prontas em São Paulo |

## Como está organizado

```
public/              telas (HTML, CSS, JS): servidas direto pela Cloudflare
src/worker.ts        entrada: /api/* vai para o app; cron a cada 5 min
src/app.ts           rotas da API (as mesmas do projeto original)
src/routes-requirements.ts
src/http.ts          roteador pequeno no lugar do Fastify (que não roda em Workers)
src/db.ts            banco via Hyperdrive (driver pg)
src/services/        regras de negócio (transações, contas, senhas, filas)
src/integrations/    email (Brevo), Google, Telegram, OCR (Workers AI), DNS
database/            SQL das migrações (as mesmas do projeto original)
tests/               testes locais contra PostgreSQL
```

### O que mudou em relação ao projeto do Render

- **Fastify → `src/http.ts`**: as rotas foram mantidas quase sem mudança.
- **Senhas:** o plano gratuito dá só 10 ms de CPU por requisição, pouco para bcrypt.
  O cálculo é feito pelo próprio PostgreSQL (extensão `pgcrypto`, que já vem
  ativa no Supabase). O formato continua bcrypt, então todas as senhas atuais
  funcionam e o Render também entende as senhas novas.
- **OCR do Telegram:** em vez do tesseract, usa um modelo de visão do Workers AI
  (`@cf/meta/llama-3.2-11b-vision-instruct`). O texto lido passa pela mesma
  função `extractReceipt` de antes.
- **Login com Google:** conferido com WebCrypto, sem a `google-auth-library`.
- **Verificação de domínio do email:** DNS-over-HTTPS (1.1.1.1), sem `node:dns`.
- **Email:** só pela API do Brevo, porque o Worker não abre conexões SMTP.
- **Tarefas de fundo** (filas do Telegram, alertas e limpeza): rodam depois de cada
  mensagem e num cron a cada 5 minutos, em vez de um processo sempre ligado.

## Configuração (uma vez só)

### 1. Hyperdrive (conexão com o Supabase)

1. No Supabase, clique em **Connect** e copie a string do **Session pooler**
   (porta 5432, endereço `aws-...-sa-east-1.pooler.supabase.com`), já com a senha.
   É a opção que funciona por IPv4. Normalmente é a mesma `DATABASE_URL` do Render.
2. Na Cloudflare, abra **Storage & Databases → Hyperdrive → Create configuration**.
   Dê o nome `cashflow-db`, cole a string e, em **Caching**, **desative o cache**.
   Com o cache ligado, uma transação recém-salva poderia demorar até 60 s para aparecer.
3. Copie o **ID** gerado e coloque em `wrangler.jsonc`, no lugar de
   `COLOQUE_AQUI_O_ID_DO_HYPERDRIVE`.

### 2. Worker ligado ao GitHub

**Workers & Pages → Create → Import a repository**, escolha este repositório e preencha:

- Build command: `npm install`
- Deploy command: `npx wrangler deploy`
- Root directory: deixe em branco (`/`)

A cada commit na `main`, a Cloudflare publica sozinha, como acontecia no Render.

### 3. Variáveis (Worker → Settings → Variables and Secrets)

| Nome | Tipo | Valor |
|---|---|---|
| `APP_ORIGIN` | Text | endereço do site, ex.: `https://cashflow.<sua-conta>.workers.dev` |
| `EMAIL_TOKEN_SECRET` | Secret | um texto aleatório longo (assina os links de confirmação de email) |
| `BREVO_API_KEY` | Secret | a mesma chave usada no Render |
| `MAIL_FROM` | Text | o mesmo remetente verificado no Brevo |
| `GOOGLE_CLIENT_ID` | Text | se usar o login com Google (o mesmo do Render) |
| `TELEGRAM_BOT_TOKEN` | Secret | se usar o bot (o mesmo do Render) |
| `TELEGRAM_WEBHOOK_SECRET` | Secret | se usar o bot (o mesmo do Render) |

Na troca de endereço, ajuste também:

- **Google:** adicione o endereço novo em *Authorized JavaScript origins* no Google Cloud Console.
- **Telegram:** aponte o webhook para o endereço novo abrindo no navegador
  `https://api.telegram.org/bot<TOKEN>/setWebhook?url=<APP_ORIGIN>/api/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>`.
  A partir daí, as mensagens deixam de ir para o Render.

## Limites do plano gratuito (por dia)

- 100.000 requisições ao Worker. As páginas e arquivos estáticos não contam.
- 100.000 consultas ao banco pelo Hyperdrive. Cada ação logada usa umas 6 consultas.
- Workers AI: cota gratuita diária, suficiente para dezenas de comprovantes.

## Testes locais

Com um PostgreSQL local, as migrações de `database/` aplicadas e o pacote `tsx`:

```
node --import tsx --test tests/local.test.ts
```

Os testes cobrem:

- login com senha antiga (bcryptjs `$2b$`) e cadastro novo;
- confirmação de email e recuperação de senha;
- transações, categorias e perfil;
- bloqueio de outra origem e limite de tentativas;
- Google, verificação de DNS e OCR, com respostas simuladas.
