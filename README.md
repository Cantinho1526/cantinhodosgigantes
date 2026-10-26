# Cantinho dos Gigantes

Sistema existente Node.js/Express + PostgreSQL. Somente PIX. Histórico financeiro,
produtos arquivados, custos, estoque, comandas, cozinha, relatórios e QR Codes preservados.

## Instalação da correção de 25/10/2026

O pacote contém uma cópia completa do código corrigido, sem banco nem credenciais.
A versão publicada não muda até o envio destes arquivos ao GitHub e o deploy no Render.

1. Guarde o backup `backup-aiven-52` e a senha BACKUP_PASSWORD já existente.
   Não substitua nem perca essa senha: os backups antigos dependem dela.
2. No Aiven → cantinho-db → Overview → Connection information → CA certificate,
   baixe o certificado `ca.pem`. Ele é público e NÃO é a senha do banco.
3. No Render → serviço cantinhodosgigantes → Environment, adicione DATABASE_CA_CERT
   com o conteúdo COMPLETO de ca.pem, incluindo BEGIN CERTIFICATE e END CERTIFICATE.
   Alternativa: Secret File aiven-ca.pem + DATABASE_CA_FILE=/etc/secrets/aiven-ca.pem.
   Mantenha DATABASE_URL, ADMIN_PIN, ADMIN_SESSION_SECRET, TABLE_QR_SECRET,
   MP_ACCESS_TOKEN e MP_WEBHOOK_SECRET com seus valores existentes.
4. No GitHub → Settings → Secrets and variables → Actions, adicione DATABASE_CA_CERT
   com o mesmo certificado. Preserve AIVEN_DATABASE_URL e BACKUP_PASSWORD.
5. Envie TODOS os arquivos do pacote para a raiz do repositório, preservando as pastas
   public, scripts, test e .github/workflows. Não envie o ZIP como substituto do código.
   A cópia antiga public/public/public/public/index.html foi removida e sua URL bloqueada.
6. Execute o workflow Verificar correcoes. Após ele passar, faça o deploy do Render.
   Build: npm ci; Start: npm start; Node: 24; Health check: /health.
   NÃO publique antes de configurar o CA: a conexão agora falha de forma segura sem ele.
7. Verifique /health, cardápio, fotos, busca, login Admin e comandas.
8. Execute Backup diario Aiven. Além de criptografar, ele agora compara a descriptografia
   e restaura a cópia num PostgreSQL temporário, conferindo tabelas, vínculos e totais de pedidos.
9. O antigo workflow Restaurar backup no Aiven foi substituído por Validar restauracao
   em banco isolado. Ele NÃO recebe a conexão de produção e NÃO altera o Aiven.
   Pode conferir o backup #52 anterior usando seu ID de execução 40197550877.

## Comandas após a atualização

Os cartões impressos A001–A200 continuam válidos. Cada atendimento tem uma sessão
própria. Um navegador de um atendimento antigo não pode ler nem enviar pedidos
para o atendimento seguinte. Nome completo sozinho não libera uma comanda em uso.

Se houver comandas abertas no momento do deploy, ou se o titular trocar de aparelho,
o Admin deve ir em Comandas QR → Autorizar outro aparelho e mostrar o QR temporário
apenas ao titular. O QR temporário só vale para aquela conta. Não o imprima nem divulgue.
O nome será solicitado no novo aparelho. Os cartões estáticos continuam sendo credenciais
físicas: mantenha-os sob controle, pois qualquer pessoa com uma cópia pode tentar iniciar
um atendimento quando o cartão estiver livre.

## Backup e preservação

- Backup diário às 09:17 UTC (06:17 de São Paulo); GitHub pode atrasar o agendamento.
- Retenção configurada em 90 dias; arquivo criptografado e checksum SHA-256.
- Sem apagar histórico, zerar pedidos ou alterar preços e estoque.
- Antigos registros de outras modalidades continuam contabilizados como histórico.
  Nenhuma nova forma de pagamento foi adicionada: o fechamento continua somente PIX.
- As únicas mudanças de esquema são aditivas (last_checked_at para a fila PIX).
- Não rode restauração na produção como teste. Recuperação real requer procedimento
  separado, janela de manutenção e revisão do backup e do destino.

## Validação realizada nesta entrega

- Testes automatizados de autorização das comandas, sessões antigas, PIX exclusivo,
  fila de conciliação, certificado, imagens, busca e envio do cabeçalho de sessão.
- Verificação de sintaxe JavaScript, YAML e shell.
- npm audit sem vulnerabilidades reportadas nas dependências de produção na preparação.
- Testes de rotas usam banco simulado; não substituem testes transacionais PostgreSQL.
- Não houve pagamento real nem acesso ao banco de produção durante a preparação.
- Restauração real do backup #52 e execução dos novos workflows ainda precisam ocorrer
  no GitHub: este ambiente não recebeu o dump, BACKUP_PASSWORD, CA nem acesso de escrita.

## Desenvolvimento

npm ci
npm test
npm start

DATABASE_URL e segredos nunca devem entrar no repositório.
