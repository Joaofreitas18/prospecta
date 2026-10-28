# Prospecta

Extensão pro Chrome que pega as empresas do Google Maps enquanto você rola a lista de resultados e mostra quem não tem site. Dá pra exportar tudo em CSV.

Fiz pra prospectar cliente sem ficar abrindo card por card. Ela não faz requisição própria, só lê o que o Maps carrega na tela.

## Como funciona

Você faz uma busca no Maps (tipo `barbearia são luís`) e vai rolando. Cada card que aparece entra na lista com nome, nota, avaliações e categoria.

O problema é que o card da lista não mostra o site. Isso só aparece no detalhe, quando você clica. Então tem duas formas de completar:

- **clicando você mesmo**: abriu o detalhe de um card, a extensão lê o site e o telefone
- **Verificar sites**: botão no painel que vai abrindo card por card sozinho, com uma pausa aleatória entre um e outro, e rola a lista quando acabam os da tela

Depois de verificado, o lead fica como:

- **sem site**: não tem site cadastrado
- **rede social**: o "site" é Instagram, Linktree, wa.me etc
- **site próprio**: tem domínio

Enquanto não verifica, fica como **não verificado**.

Cada lead ganha um score de 0 a 100. A ideia é priorizar quem não tem site mas já tem movimento (muita avaliação, nota boa, telefone). Negócio sem site e com 3 avaliações não vale a ligação. A conta fica em `scoreLead()` no `src/parser.js`.

O ícone da extensão abre um painel lateral com as capturas ao vivo, os melhores leads e a exportação. O número no ícone é a quantidade de leads sem site próprio.

## Instalar

1. Clona ou baixa o repo
2. Abre `chrome://extensions` e liga o modo do desenvolvedor
3. **Carregar sem compactação** e seleciona a pasta

Precisa do Chrome 116+ por causa do painel lateral.

## CSV

Separado por `;` com BOM, abre direto no Excel. Colunas: score, nome, categoria, telefone, endereço, nota, avaliações, tipo de site, verificado, site, busca, link do Maps e data da captura.

O Maps mostra no máximo uns 120 resultados por busca, então vale buscar por bairro. Os leads vão acumulando entre buscas e não duplicam.

## Problemas conhecidos

- O Google muda o HTML do Maps sem avisar. O parser usa atributos ARIA e texto em vez de classe CSS pra quebrar menos, mas uma hora quebra. Quando acontecer, o ajuste é no `src/parser.js`.
- Se você recarregar a extensão com o Maps aberto, ela tenta se reconectar sozinha. Se o contador na página ficar vermelho, é só dar F5.

## Aviso

Os termos do Google Maps não permitem extração automatizada, então isso aqui é pra estudo e prospecção manual. Pra usar em escala o caminho é a [Places API](https://developers.google.com/maps/documentation/places/web-service). E se for entrar em contato com MEI ou autônomo, lembra que é dado pessoal pela LGPD.

## Licença

MIT
