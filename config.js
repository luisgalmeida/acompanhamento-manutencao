/* Configuração do Supabase.
   Supabase > Project Settings > API:
     - "Project URL"            -> url
     - "anon public" (chave)    -> anonKey
   A chave anon é pública por natureza (quem protege os dados são as regras do banco).
   NUNCA coloque aqui a chave "service_role". */
const CONFIG = {
  url: "https://ghgmhfpfmrsikxnrcitp.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdoZ21oZnBmbXJzaWt4bnJjaXRwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxNjE0MzQsImV4cCI6MjEwNzczNzQzNH0.Wawv8ebc59KSmhW-AcgWpDE_1Tfrt_sOgfvu-TSm1ko",
  // Os usuários são criados no Supabase com e-mails  admin@DOMINIO, vendedor@DOMINIO,
  // manutencao@DOMINIO e expedicao@DOMINIO (o domínio pode ser qualquer um, não precisa existir).
  dominio: "acompanhamento.app"
};
