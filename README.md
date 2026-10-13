# Agenda do barbeiro — servidor

Servidor com contas (email + senha), sessões, agenda salva por usuário e **recuperação de senha por email**.
Só precisa do Node.js 18+ (não há dependências para instalar).

## Rodar no seu computador
```bash
cd barbearia-servidor
node server.js
```
Abra http://localhost:3000. Sem email configurado, o link de recuperação aparece no terminal.

## Colocar online (para usar em vários aparelhos)
**Passo a passo completo, pensado para quem nunca hospedou nada: veja `HOSPEDAR.md`.**

1. Hospede a pasta em um serviço com Node.js (Render, Railway, Fly.io, uma VPS etc.). Comando de início: `node server.js`.
2. Use um **disco persistente** e aponte `DB_FILE` para ele (ex.: `/dados/db.json`). Sem isso, os dados somem a cada deploy.
3. Use **HTTPS** (a maioria dos serviços já oferece) e defina `BASE_URL` com o endereço público. Atrás de proxy, use `TRUST_PROXY=1`.
4. Email de recuperação: crie conta em https://resend.com, verifique seu domínio e preencha `RESEND_API_KEY` e `MAIL_FROM`.

Copie `.env.example` para `.env` (ou use as variáveis de ambiente do serviço) e preencha.

## O que ele faz
- Senhas guardadas com scrypt + salt; sessão em cookie HttpOnly (30 dias).
- Recuperação: link de uso único, válido por 1 hora; ao redefinir, todos os aparelhos são desconectados.
- A recuperação nunca revela se um email existe. Há limite de tentativas por IP.
- Cada conta tem sua agenda e seus serviços, salvos automaticamente no servidor.

## Acesso de colaboradores (barbeiros)
- O dono abre **Dados da barbearia › Barbeiros › [barbeiro] › Acesso ao app** e cria um email e uma senha para ele.
- O colaborador entra com esse login e vê só a própria agenda e o próprio faturamento. Não vê Dados da barbearia, os outros barbeiros, nem o email dos clientes, e não exclui clientes.
- O servidor faz essa filtragem: mesmo mexendo no navegador, o colaborador não consegue ler nem gravar dados de outros barbeiros ou da barbearia.
- Se duas pessoas editarem ao mesmo tempo, o servidor junta as alterações (controle de versão). Remover o acesso ou excluir o barbeiro encerra o login dele.

## Agendamento online (link para o cliente)
- O dono abre o menu › **Agendamento online**, ativa a opção e copia o link (ou compartilha). O link tem o formato `https://seu-endereco/agendar/xxxxxxxxxx`.
- O cliente escolhe o serviço, o barbeiro (ou "sem preferência"), a data e o horário, informa nome e telefone (e-mail é opcional) e escolhe a forma de pagamento. Pagamento: Pix, dinheiro ou cartão, **pago na barbearia**; se você preencher a chave Pix, ela aparece na confirmação.
- Só aparecem horários realmente livres, respeitando expediente, almoço, horários fechados, duração do serviço e os serviços de cada barbeiro. Dois clientes nunca pegam o mesmo horário.
- Regras ajustáveis: antecedência mínima, até quantos dias à frente, escolher barbeiro ou não, quais serviços e barbeiros aparecem online.
- Clientes bloqueados não conseguem agendar. Há limite de tentativas por IP e por telefone, e no máximo 3 agendamentos futuros online por cliente.
- O fuso horário é definido em `SHOP_TZ` (padrão `America/Sao_Paulo`).
- Os agendamentos entram direto na agenda, marcados como "online". O dono vê em até 20 segundos com o app aberto (não há notificação push).
- "Gerar novo link" desativa o link antigo.

## Limites desta versão
- Os dados ficam em um arquivo JSON: serve para uma barbearia pequena. Faça backup de `data/db.json`.
- Um único servidor. Para muitas contas, troque o arquivo por um banco (PostgreSQL/SQLite).
- Não há confirmação de email no cadastro nem verificação em duas etapas.

## Não consigo entrar ("e-mail ou senha incorretos")
1. **Conta criada em outro lugar:** cada versão tem as próprias contas. Uma conta criada na página publicada no Claude (que guarda tudo só no navegador) **não existe** neste servidor. Crie a conta aqui, ou use "Importar backup" na versão local.
2. **Disco não persistente:** ao iniciar, o servidor escreve no log "Banco de dados: ... N conta(s) carregada(s)". Se N for 0 depois de um reinício ou de uma atualização, o disco do seu serviço não é persistente: configure `DB_FILE` para um disco persistente (veja "Colocar online"), senão as contas somem.
3. **Espaço no fim da senha:** teclados de celular às vezes acrescentam um espaço. O app agora tenta de novo sem o espaço e já não permite maiúscula ou autocorreção nos campos de e-mail e senha.
4. **Muitas tentativas:** depois de 10 tentativas erradas em 15 minutos, o servidor pede para aguardar.
5. **Esqueci a senha:** use o botão "Esqueci a senha" (precisa do envio de e-mail configurado).
