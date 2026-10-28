# Prospecta

Extensão pro Chrome que pega as empresas do Google Maps enquanto você rola a lista de resultados e mostra quem não tem site. Dá pra exportar tudo em CSV.

Fiz pra prospectar cliente sem ficar abrindo card por card. Ela lê o que o próprio Maps baixa enquanto você usa, sem bater em API nenhuma.

## Como funciona

Você faz uma busca no Maps (`google.com/maps` ou `google.com.br/maps`, tipo `barbearia são luís`) e vai rolando. Cada card que aparece entra na lista com nome, nota, avaliações e categoria.

O card da lista não mostra o site, mas o Maps baixa os resultados de 20 em 20 e cada lote já vem com site, telefone, endereço e coordenadas de todo mundo. A extensão lê esses lotes no momento em que chegam, então não precisa clicar em nada:

- **rolando você mesmo**: cada lote que o Maps carrega entra classificado na hora
- **Capturar tudo**: a extensão rola a lista sozinha até o fim. Uma busca inteira (uns 120 resultados) leva uns 15 segundos

Se algum lead não vier no lote, a extensão abre o card dele pra completar. Isso é só reserva e dá pra desligar no painel.

Depois de verificado, o lead fica como:

- **sem site**: não tem site cadastrado
- **rede social**: o "site" é Instagram, Linktree, wa.me etc
- **site próprio**: tem domínio

Cada lead ganha um score de 0 a 100. A ideia é priorizar quem não tem site mas já tem movimento (muita avaliação, nota boa, telefone). Negócio sem site e com 3 avaliações não vale a ligação. A conta fica em `scoreLead()` no `src/parser.js`.

O ícone da extensão abre um painel lateral com as capturas ao vivo, os melhores leads e a exportação. Clicando no nome de um lead abre a ficha dele, com mapa, endereço, telefone, site, horário e atalho de rotas. O número no ícone é a quantidade de leads sem site próprio.

A versão aparece no painel e na barrinha da página do Maps. Se depois de atualizar o número não mudou, o Chrome ainda está carregando a pasta antiga.

## Instalar

1. Clona ou baixa o repo
2. Abre `chrome://extensions` e liga o modo do desenvolvedor
3. **Carregar sem compactação** e seleciona a pasta

Precisa do Chrome 116+ por causa do painel lateral.

## CSV

Separado por `;` com BOM, abre direto no Excel. Colunas: score, nome, categoria, telefone, endereço, nota, avaliações, tipo de site, verificado, site, horário, latitude, longitude, busca, link do Maps e data da captura.

O Maps mostra no máximo uns 120 resultados por busca, então vale buscar por bairro. Os leads vão acumulando entre buscas e não duplicam.

## Problemas conhecidos

- O Google muda o HTML do Maps sem avisar. O parser usa atributos ARIA e texto em vez de classe CSS pra quebrar menos, mas uma hora quebra. Quando acontecer, o ajuste é no `src/parser.js`.
- Se você recarregar a extensão com o Maps aberto, ela tenta se reconectar sozinha. Se o contador na página ficar vermelho, é só dar F5.
- O formato dos lotes não é documentado. Se o Google mudar, a leitura fica em `parseSearchBody()` no `src/parser.js`, e enquanto isso a extensão cai pro modo de abrir card por card, que é mais lento (uns 3 segundos por lead).
- Com várias abas do Maps abertas, só a aba que está na frente abre cards. Os lotes são lidos em todas.

## Aviso

Os termos do Google Maps não permitem extração automatizada, então isso aqui é pra estudo e prospecção manual. Pra usar em escala o caminho é a [Places API](https://developers.google.com/maps/documentation/places/web-service). E se for entrar em contato com MEI ou autônomo, lembra que é dado pessoal pela LGPD.

## Licença

MIT. As fontes Manrope e JetBrains Mono são OFL, licenças na pasta `fonts/`.
