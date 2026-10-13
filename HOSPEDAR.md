# Como colocar a agenda no ar (passo a passo)

Este guia usa o **Render** porque ele já aceita este pacote pronto (arquivo `render.yaml`). Você faz tudo pelo navegador, sem instalar nada. Leva uns 15 minutos.

> **Atenção ao plano gratuito:** no plano grátis do Render os arquivos são apagados a cada reinício e a cada atualização, e o serviço "dorme" após 15 minutos sem uso. Isso apagaria **todas as contas e agendamentos**. Use um plano **pago** (o de entrada, "Starter"), que permite o disco persistente. Confira o preço atual na página de preços do Render antes de confirmar.

## 1. Guardar os arquivos no GitHub
1. Crie uma conta em https://github.com (grátis).
2. Toque em **New repository**, dê o nome `agenda-barbeiro` e escolha **Private** (privado). Crie.
3. No repositório, toque em **uploading an existing file**.
4. Descompacte o zip no computador e **arraste o conteúdo da pasta** (não o zip): `server.js`, `package.json`, `render.yaml`, `README.md`, `.env.example` e a pasta `public` inteira. Toque em **Commit changes**.
   - Feito pelo celular fica trabalhoso. Se puder, use um computador.

## 2. Criar o serviço no Render
1. Crie uma conta em https://render.com e entre com o GitHub.
2. Toque em **New +** › **Blueprint** e escolha o repositório `agenda-barbeiro`.
3. O Render lê o `render.yaml`: serviço **agenda-barbeiro**, plano **Starter** e um disco de 1 GB em `/dados`. Confirme (ele pede o cartão).
4. Espere o **deploy** terminar (2 a 3 minutos). O endereço aparece no topo, no formato `https://agenda-barbeiro-xxxx.onrender.com`.

## 3. Testar
1. Abra o endereço no celular e no computador. Toque em **Criar conta** e cadastre o e-mail e a senha.
2. Entre com os mesmos dados no **outro aparelho**. Deve funcionar.
3. Confira no Render, em **Logs**, a linha `Banco de dados: /dados/db.json — 1 conta(s) carregada(s)`. Depois de **Manual Deploy › Clear build cache & deploy**, a linha deve mostrar **1 conta** de novo: é a prova de que o disco guarda os dados.

## 4. Recuperação de senha por e-mail (opcional, recomendado)
1. Crie uma conta em https://resend.com e gere uma **API Key**.
2. Verifique o seu domínio no Resend (precisa ser um domínio seu, por exemplo `suabarbearia.com.br`).
3. No Render, abra o serviço › **Environment** e adicione:
   - `RESEND_API_KEY` = a chave do Resend
   - `MAIL_FROM` = `Agenda do barbeiro <no-reply@suabarbearia.com.br>`
4. Salve. O Render reinicia sozinho. Teste o botão **Esqueci a senha**.
Sem isso o app funciona, mas o link de recuperação só aparece nos logs do servidor.

## 5. Usar o seu domínio (opcional)
No Render, em **Settings › Custom Domains**, adicione `agenda.suabarbearia.com.br` e crie no seu provedor de domínio o registro que o Render mostrar. O HTTPS é automático.

## 6. Depois de no ar
- **Link de agendamento dos clientes:** menu › **Meu link**.
- **Atualizar o app:** troque os arquivos no GitHub. O Render publica sozinho, e os dados no disco não são afetados.
- **Backup:** o Render faz uma cópia do disco a cada 24 horas. Guarde também uma cópia do arquivo `db.json` de vez em quando.
- **Segurança:** mantenha o repositório privado, não coloque senhas nem chaves nos arquivos e use senhas fortes.

## Outras opções
Qualquer serviço que rode Node.js 18 ou mais novo e tenha **disco persistente** serve (Railway, Fly.io, um servidor VPS). Sempre defina `DB_FILE` para um caminho dentro do disco persistente e `TRUST_PROXY=1` se houver proxy na frente. Detalhes no `README.md`.
