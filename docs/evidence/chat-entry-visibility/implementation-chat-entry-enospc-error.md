# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: chat-entry-visibility.spec.ts >> chat entry visibility approved contract >> short mobile viewport keeps the full menu and search controls inside the shared scrollport
- Location: tests/chat-entry-visibility.spec.ts:429:3

# Error details

```
Error: пробная сборка «non-demo preview payment plus chat» не собралась — это «измерить не удалось», а не «нарушений нет».
(node:81238) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
(Use `node --trace-warnings ...` to show where the warning was created)
(node:81497) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
(Use `node --trace-warnings ...` to show where the warning was created)
ENOSPC: no space left on device, mkdir '/private/tmp/ikpk-widget-probe-V2Z7Bu/institut-apledzhera/kraniosakralnaya-terapiya/somato-emocionalnoe-osvobozhdenie-2/'
  Location:
    /Users/pgorbachev/projects/private/ikpk/.claude/worktrees/chat-entry-impl-20261021/web/node_modules/astro/dist/core/build/generate.js:438:3
  Stack trace:
    at async Object.mkdir (node:internal/fs/promises:856:10)
    at async generatePages (file:///Users/pgorbachev/projects/private/ikpk/.claude/worktrees/chat-entry-impl-20261021/web/node_modules/astro/dist/core/build/generate.js:159:11)
    at async Object.buildApp (file:///Users/pgorbachev/projects/private/ikpk/.claude/worktrees/chat-entry-impl-20261021/web/node_modules/vite/dist/node/chunks/node.js:33477:5)
    at async viteBuild (file:///Users/pgorbachev/projects/private/ikpk/.claude/worktrees/chat-entry-impl-20261021/web/node_modules/astro/dist/core/build/static-build.js:63:3)
    at async AstroBuilder.run (file:///Users/pgorbachev/projects/private/ikpk/.claude/worktrees/chat-entry-impl-20261021/web/node_modules/astro/dist/core/build/index.js:202:7)

10:59:52 [types] Generated 100ms
10:59:52 [build] output: "static"
10:59:52 [build] mode: "static"
10:59:52 [build] directory: /private/tmp/ikpk-widget-probe-V2Z7Bu/
10:59:52 [build] Collecting build info...
10:59:52 [build] ✓ Completed in 155ms.
10:59:52 [build] Building static entrypoints...
10:59:54 [vite] ✓ built in 1.68s
10:59:57 [vite] ✓ built in 3.28s
10:59:57 [build] Rearranging server assets...

 generating static routes 
10:59:57   ├─ /404.html (+14ms) 
10:59:57   ├─ /aktsii-i-skidki/index.html (+14ms) 
10:59:57   ├─ /demo-zayavka/index.html (+21ms) 
10:59:57   ├─ /instituty/institut-klinicheskoy-prikladnoy-kineziologii/index.html (+5ms) 
10:59:57   ├─ /instituty/institut-apledzhera/index.html (+3ms) 
10:59:57   ├─ /instituty/institut-barralya/index.html (+3ms) 
10:59:57   ├─ /instituty/index.html (+5ms) 
10:59:57   ├─ /kontakty/index.html (+5ms) 
10:59:57   ├─ /oplata/index.html (+19ms) 
10:59:57   ├─ /politika-konfidencialnosti/index.html (+6ms) 
10:59:57   ├─ /preview/hub/index.html (+4ms) 
10:59:57   ├─ /preview/editorial/schedule/index.html (+12ms) 
10:59:57   ├─ /preview/faculty/schedule/index.html (+8ms) 
10:59:57   ├─ /preview/modular/schedule/index.html (+8ms) 
10:59:57   ├─ /preview/editorial/seminar/index.html (+27ms) 
10:59:58   ├─ /preview/faculty/seminar/index.html (+21ms) 
10:59:58   ├─ /preview/modular/seminar/index.html (+22ms) 
10:59:58   ├─ /preview/editorial/seminar-undated/index.html (+17ms) 
10:59:58   ├─ /preview/faculty/seminar-undated/index.html (+44ms) 
10:59:58   ├─ /preview/modular/seminar-undated/index.html (+20ms) 
10:59:58   ├─ /preview/editorial/index.html (+29ms) 
10:59:58   ├─ /preview/faculty/index.html (+20ms) 
10:59:58   ├─ /preview/modular/index.html (+17ms) 
10:59:58   ├─ /preview/b/index.html (+8ms) 
10:59:58   ├─ /preview/c/index.html (+8ms) 
10:59:58   ├─ /preview/d/index.html (+11ms) 
10:59:58   ├─ /programmy/kraniosakralnaya-terapiya/index.html (+4ms) 
10:59:58   ├─ /programmy/prikladnaya-kineziologiya/index.html (+3ms) 
10:59:58   ├─ /programmy/visceralnye-tehniki/index.html (+4ms) 
10:59:58   ├─ /programmy/prodvinutye-visceralnye-tehniki/index.html (+6ms) 
10:59:58   ├─ /programmy/nevralnye-tehniki/index.html (+5ms) 
10:59:58   ├─ /programmy/tehniki-vyslushivaniya/index.html (+4ms) 
10:59:58   ├─ /programmy/novyj-manualnyj-podhod-k-sustavam/index.html (+33ms) 
10:59:58   ├─ /programmy/postdiplomnye-programmy-po-prikladnoj-kineziologii/index.html (+5ms) 
10:59:58   ├─ /programmy/primenenie-principov-akupunktury/index.html (+3ms) 
10:59:58   ├─ /programmy/pereprogrammirovanie-nejroreceptornyh-zon-v-pk/index.html (+4ms) 
10:59:58   ├─ /programmy/kurs-po-kitajskoj-medicine-s-pozicij-prikladnoj-kineziologii/index.html (+4ms) 
10:59:58   ├─ /programmy/imunnyj-otvet/index.html (+3ms) 
10:59:58   ├─ /programmy/prikladnaya-kineziologiya-dlya-fitnesa/index.html (+4ms) 
10:59:58   ├─ /programmy/specializirovannye-programmy/index.html (+4ms) 
10:59:58   ├─ /programmy/dolgoletie/index.html (+4ms) 
10:59:58   ├─ /programmy/psihokineziologiya/index.html (+26ms) 
10:59:58   ├─ /programmy/avtorskie-seminary-zharovoj-ls/index.html (+3ms) 
10:59:58   ├─ /programmy/pediatriya-akusherstvo-i-novorozhdennye/index.html (+3ms) 
10:59:58   ├─ /programmy/mozg/index.html (+3ms) 
10:59:58   ├─ /programmy/kraniosakralnaya-terapiya-specializirovannye/index.html (+3ms) 
10:59:58   ├─ /programmy/massazh/index.html (+3ms) 
10:59:58   ├─ /programmy/korrekciya-strukturnyh-narushenij-osteoprakticheskimi-i-myshechno-energeticheskimi-tehnikami/index.html (+3ms) 
10:59:58   ├─ /programmy/specializirovannye/index.html (+2ms) 
10:59:58   ├─ /programmy/vibracionnaya-medicina/index.html (+2ms) 
10:59:58   ├─ /programmy/vebinary-i-mezhseminarskie-vstrechi/index.html (+2ms) 
10:59:58   ├─ /programmy/vebinary-i-mezhseminarskie-vstrechi-ikpk/index.html (+2ms) 
10:59:58   ├─ /programmy/index.html (+4ms) 
10:59:58   ├─ /raspisanie-i-tseny/index.html (+73ms) 
10:59:58   ├─ /rich-content-canary/index.html (+7ms) 
10:59:58   ├─ /robots.txt (+2ms) 
10:59:58   ├─ /seminary/antistressovaya-kineziologiya-vvedenie-1/index.html (+4ms) 
10:59:58   ├─ /seminary/bryushnaya-polost-1/index.html (+3ms) 
10:59:58   ├─ /seminary/infekcii-i-psevdoinfekcii-vvedenie-v-gelmintologiyu-nematody/index.html (+3ms) 
10:59:58   ├─ /seminary/ispolzovanie-meridianov-v-kranio-sakralnoj-terapii-1/index.html (+3ms) 
10:59:58   ├─ /seminary/korrekciya-strukturnyh-narushenij-tazovogo-regiona-i-nizhnih-konechnostej/index.html (+3ms) 
10:59:58   ├─ /seminary/kraniosakralnaya-terapiya-1/index.html (+3ms) 
10:59:58   ├─ /seminary/kraniosakralnaya-terapiya-dlya-omolozheniya-i-dolgoletiya/index.html (+3ms) 
10:59:58   ├─ /seminary/kraniosakralnaya-terapiya-i-immunnyj-otvet/index.html (+6ms) 
10:59:58   ├─ /seminary/kraniosakralnaya-terapiya-i-zhiznennyj-cikl/index.html (+3ms) 
10:59:58   ├─ /seminary/kraniosakralnaya-terapiya-v-pediatrii-1/index.html (+3ms) 
10:59:58   ├─ /seminary/meridiany-kitajskaya-klassicheskaya-medicina-s-pozicii-prikladnoj-kineziologii-i-nevrologii-nejro-tkm-1/index.html (+3ms) 
10:59:58   ├─ /seminary/miofascialnyj-i-bukkalnyj-massazh-lica/index.html (+3ms) 
10:59:58   ├─ /seminary/myshechnoe-testirovanie-mmt-podhody-k-diagnostike-i-algoritmy-raboty-s-myshcami/index.html (+3ms) 
10:59:58   ├─ /seminary/osnovy-manualnogo-myshechnogo-testirovaniya/index.html (+3ms) 
10:59:58   ├─ /seminary/seminar-1/index.html (+3ms) 
10:59:58   ├─ /seminary/stimulyaciya-zhiznennoj-sily-kletki-1/index.html (+4ms) 
10:59:58   ├─ /seminary/strukturnaya-sostavlyayushaya-treugolnika-zdorovya/index.html (+4ms) 
10:59:58   ├─ /seminary/yadra-mozga-nevrologicheskij-podhod-k-diagnostike-i-funkcionalnoj-korrekcii/index.html (+3ms) 
10:59:58   ├─ /seminary/antistressovaya-kineziologiya-2/index.html (+3ms) 
10:59:58   ├─ /seminary/diagnostika-prichin-oslableniya-myshc-i-algoritm-raboty-so-slabymi-myshcami/index.html (+3ms) 
10:59:58   ├─ /seminary/disfunkcii-yader-cherepno-mozgovyh-nervov/index.html (+3ms) 
10:59:58   ├─ /seminary/ispolzovanie-meridianov-v-kranio-sakralnoj-terapii-2/index.html (+3ms) 
10:59:58   ├─ /seminary/korrekciya-strukturnyh-narushenij-poyasnichnogo-grudnogo-otdelov-pozvonochnika-i-grudnoj-kletki/index.html (+3ms) 
10:59:58   ├─ /seminary/kraniosakralnaya-terapiya-2/index.html (+3ms) 
10:59:58   ├─ /seminary/meridiany-kitajskaya-klassicheskaya-medicina-s-pozicii-prikladnoj-kineziologii-i-nevrologii-nejro-tkm-2/index.html (+3ms) 
10:59:58   ├─ /seminary/miofascialnyj-massazh-tela-armoplastika/index.html (+4ms) 
10:59:58   ├─ /seminary/seminar-2-srednij-uroven/index.html (+3ms) 
10:59:58   ├─ /seminary/strukturnaya-sostavlyayushaya-treugolnika-zdorovya-obshie-diagnosticheskie-i-lechebnye-procedury-2/index.html (+4ms) 
10:59:58   ├─ /seminary/bolevye-sindromy-i-rabota-s-nimi/index.html (+3ms) 
10:59:58   ├─ /seminary/csp-2-kraniosakralnaya-terapiya-v-pediatrii-2/index.html (+3ms) 
10:59:58   ├─ /seminary/disfunkciya-visochno-nizhnechelyustnogo-sustava-vnchs/index.html (+4ms) 
10:59:58   ├─ /seminary/gelmintozy-nematodozy-cestodozy-trematodozy/index.html (+3ms) 
10:59:58   ├─ /seminary/ispolzovanie-meridianov-v-kranio-sakralnoj-terapii-3/index.html (+3ms) 
10:59:58   ├─ /seminary/korrekciya-strukturnyh-narushenij-shejnogo-otdela-pozvonochnika-pleche-lopatochnogo-regiona-i-verhnih-konechnostej/index.html (+3ms) 
10:59:58   ├─ /seminary/meridiany-kitajskaya-klassicheskaya-medicina-s-pozicii-prikladnoj-kineziologii-i-nevrologii-nejro-tkm-3/index.html (+3ms) 
10:59:58   ├─ /seminary/miofascialnyj-massazh-tela-zhenskij-massazh/index.html (+3ms) 
10:59:58   ├─ /seminary/pereprogrammirovanie-nejroreceptornyh-polej-p-dtr/index.html (+3ms) 
10:59:58   ├─ /seminary/seminar-1-prodvinutyj-uroven/index.html (+3ms) 
10:59:58   ├─ /seminary/somato-emocionalnoe-osvobozhdenie-1/index.html (+3ms) 
10:59:58   ├─ /seminary/strukturnaya-sostavlyayushaya-treugolnika-zdorovya-obshie-diagnosticheskie-i-lechebnye-procedury/index.html (+3ms) 
10:59:58   ├─ /seminary/ispolzovanie-meridianov-v-kranio-sakralnoj-terapii-4/index.html (+3ms) 
10:59:58   ├─ /seminary/karta-patologij/index.html (+3ms) 
10:59:58   ├─ /seminary/korrekciya-shramov/index.html (+4ms) 
10:59:58   ├─ /seminary/kraniosakralnaya-terapiya-za-predelami-osnovaniya-cherepa/index.html (+3ms) 
10:59:58   ├─ /seminary/seminar-4-nejropatii-s-pozicii-nejroreceptornyh-polej/index.html (+3ms) 
10:59:58   ├─ /seminary/somato-emocionalnoe-osvobozhdenie-2/index.html (+4ms) 
10:59:58   ├─ /seminary/vebinar-endokrinotoksichnost-vneshnej-sredy/index.html (+3ms) 
10:59:58   ├─ /seminary/visceralnaya-terapiya-s-osnovami-prikladnoj-kineziologii-organov-grudnoj-i-bryushnoj-polostej-i-malogo-taza/index.html (+3ms) 
10:59:58   ├─ /seminary/vnutrennie-organy-i-ih-vliyanie-na-myshcy/index.html (+3ms) 
10:59:58   ├─ /seminary/bryushnaya-polost-2/index.html (+3ms) 
10:59:58   ├─ /seminary/individualnye-osobennosti-cheloveka-1/index.html (+3ms) 
10:59:58   ├─ /seminary/ispolzovanie-meridianov-v-kranio-sakralnoj-terapii-5/index.html (+3ms) 
10:59:58   ├─ /seminary/kineziotejpirovanie-lica-i-tela/index.html (+3ms) 
10:59:58   ├─ /seminary/korrekciya-patologicheskoj-aktivnosti-primitivnyh-refleksov-2/index.html (+3ms) 
10:59:58   ├─ /seminary/korrekciya-patologicheskoj-aktivnosti-primitivnyh-refleksov-s-pozicii-prikladnoj-kineziologii/index.html (+3ms) 
10:59:58   ├─ /seminary/kraniosakralnaya-sistema/index.html (+3ms) 
10:59:58   ├─ /seminary/kraniosakralnaya-terapiya-edvans-1/index.html (+3ms) 
10:59:58   ├─ /seminary/kst-v-akusherstve-uroven-1/index.html (+3ms) 
10:59:58   ├─ /seminary/mezhseminarskaya-vstrecha-praktikum-dlya-specialistov-kst/index.html (+3ms) 
10:59:58   ├─ /seminary/mozg-govorit-1/index.html (+3ms) 
10:59:58   ├─ /seminary/myshechnoe-testirovanie-vizualnoe-vyyavlenie-narushenij-oporno-dvigatelnoj-sistemy/index.html (+2ms) 
10:59:58   ├─ /seminary/seminar-praktikum-znakomstvo-s-prikladnoj-kineziologiej/index.html (+3ms) 
10:59:58   ├─ /seminary/funkcionalnye-narusheniya-emocionalnoj-sfery/index.html (+3ms) 
10:59:58   ├─ /seminary/individualnye-osobennosti-cheloveka-2/index.html (+3ms) 
10:59:58   ├─ /seminary/kraniosakralnaya-terapiya-edvans-2/index.html (+3ms) 
10:59:58   ├─ /seminary/kraniosakralnaya-terapiya-i-somato-emocionalnoe-osvobozhdenie/index.html (+3ms) 
10:59:58   ├─ /seminary/rabota-s-chakrami-v-terapevticheskoj-telesnoj-praktike/index.html (+4ms) 
10:59:58   ├─ /seminary/raskruchivanie-meridianov-primenenie-principov-akupunktury-v-kraniosakralnoj-terapii/index.html (+3ms) 
10:59:58   ├─ /seminary/sistemnoe-primenenie-kineziologicheskogo-tejpirovaniya-lica-i-tela/index.html (+3ms) 
10:59:58   ├─ /seminary/bezopasnost-kak-bazovaya-potrebnost-cheloveka/index.html (+3ms) 
10:59:58   ├─ /seminary/endokrinotoksichnost/index.html (+3ms) 
10:59:58   ├─ /seminary/funkcionalnye-narusheniya-biohimicheskih-processov/index.html (+3ms) 
10:59:58   ├─ /seminary/nejropsihokineziologiya-1/index.html (+3ms) 
10:59:58   ├─ /seminary/travma-i-energeticheskoe-telo/index.html (+3ms) 
10:59:58   ├─ /seminary/funkcionalnye-narusheniya-elektromagnitnyh-processov/index.html (+3ms) 
10:59:58   ├─ /seminary/telo-v-trevoge-put-k-vosstanovleniyu/index.html (+3ms) 
10:59:58   ├─ /seminary/vebinar-nejro-tkm-diagnostika-meridianov-s-pozicii-sovremennoj-nevrologii/index.html (+3ms) 
10:59:58   ├─ /seminary/csstr-kraniosakralnaya-terapiya-i-reakciya-na-stressovuyu-travmu/index.html (+5ms) 
10:59:58   ├─ /seminary/osnovy-energeticheskoj-kineziologii-1/index.html (+3ms) 
10:59:58   ├─ /seminary/kineziologiya-zdorovya-1/index.html (+3ms) 
10:59:58   ├─ /seminary/mozg-govorit-2/index.html (+5ms) 
10:59:58   ├─ /seminary/nejropsihokineziologiya-2/index.html (+3ms) 
10:59:58   ├─ /seminary/seminar-praktikum-dlya-specialistov-kraniosakralnoj-terapii/index.html (+3ms) 
10:59:58   ├─ /seminary/stimulyaciya-zhiznennoj-sily-kletki-prodvinutyj-uroven/index.html (+3ms) 
10:59:58   ├─ /seminary/taz/index.html (+3ms) 
10:59:58   ├─ /seminary/intensiv-dlya-prikladnyh-kineziologov/index.html (+11ms) 
10:59:58   ├─ /seminary/kineziologiya-zdorovya-2/index.html (+3ms) 
10:59:58   ├─ /seminary/strahi-i-fobii-fap/index.html (+3ms) 
10:59:58   ├─ /seminary/formirovanie-muzhskogo-i-zhenskogo-povedeniya/index.html (+3ms) 
10:59:58   ├─ /seminary/integraciya-protokolov-kst-energeticheskaya-kista-globalnaya-diagnostika-tela/index.html (+3ms) 
10:59:58   ├─ /seminary/korrekciya-lozhnyh-ubezhdenij-dajmond-psihokineziologiya/index.html (+3ms) 
10:59:58   ├─ /seminary/nejropsihokineziologiya-3/index.html (+3ms) 
10:59:58   ├─ /seminary/tendinopatiya-zdorove-ruk-massazhista-i-ne-tolko/index.html (+3ms) 
10:59:58   ├─ /seminary/semejnye-otnosheniya/index.html (+3ms) 
10:59:58   ├─ /seminary/energeticheskaya-sistema-cheloveka/index.html (+2ms) 
10:59:58   ├─ /seminary/grudnaya-kletka/index.html (+2ms) 
10:59:58   ├─ /seminary/infekcii-i-psevdoinfekcii/index.html (+3ms) 
10:59:58   ├─ /seminary/kst-pogovorim-o-sluchayah-iz-praktiki-voprosy-i-otvety/index.html (+4ms) 
10:59:58   ├─ /seminary/miofascialnye-cepi-i-ih-znachenie-v-rabote-kineziologa/index.html (+3ms) 
10:59:58   ├─ /seminary/opredelenie-tipov-doshi-po-kristoferu-smitu/index.html (+3ms) 
10:59:58   ├─ /seminary/vebinar-s-chego-nachinaetsya-kst/index.html (+3ms) 
10:59:58   ├─ /seminary/kak-dostich-izobiliya/index.html (+2ms) 
10:59:58   ├─ /seminary/kineziologiya-uglevodnyj-obmen-1/index.html (+3ms) 
10:59:58   ├─ /seminary/manualnaya-termoocenka-i-vvedenie-v-viscero-emocionalnuyu-sferu/index.html (+2ms) 
10:59:58   ├─ /seminary/sabotazh-eto-chashe-chem-vy-dumaete/index.html (+3ms) 
10:59:58   ├─ /seminary/vebinar-kst-tehniki-lyogkogo-prikosnoveniya/index.html (+3ms) 
10:59:58   ├─ /seminary/funkcionalnyj-podhod-ot-nejtralnosti-k-zdorovyu/index.html (+3ms) 
10:59:58   ├─ /seminary/integrativnyj-podhod-k-travme/index.html (+3ms) 
10:59:58   ├─ /seminary/slozhnye-formy-povedeniya/index.html (+3ms) 
10:59:58   ├─ /seminary/revnost-zavist-otricanie-sebya/index.html (+3ms) 
10:59:58   ├─ /seminary/tehniki-raboty-na-perifericheskih-nervah-verhnyaya-chast-tela/index.html (+3ms) 
10:59:58   ├─ /seminary/viscerotoksichnost-i-osnovy-detoksikacii/index.html (+4ms) 
10:59:58   ├─ /seminary/proshenie/index.html (+2ms) 
10:59:58   ├─ /seminary/tehniki-raboty-na-perifericheskih-nervah-nizhnyaya-chast-tela/index.html (+3ms) 
10:59:58   ├─ /seminary/manipulyacii-na-kranialnyh-nervah/index.html (+3ms) 
10:59:58   ├─ /seminary/centralnye-i-perifericheskie-svyazi/index.html (+3ms) 
10:59:58   ├─ /seminary/viscero-sosudistye-tehniki-nizhnyaya-chast-tela/index.html (+3ms) 
10:59:58   ├─ /seminary/visceralnye-komponenty-shei-i-grudnoj-kletki/index.html (+3ms) 
10:59:58   ├─ /seminary/integrativnyj-podhod-k-ocenke-1/index.html (+2ms) 
10:59:58   ├─ /seminary/verhnie-konechnosti/index.html (+3ms) 
10:59:58   ├─ /seminary/nizhnie-konechnosti/index.html (+2ms) 
10:59:58   ├─ /seminary/pozvonochnik-i-taz/index.html (+3ms) 
10:59:58   ├─ /seminary/bluzhdayushij-nerv-i-vegetativnaya-nervnaya-sistema/index.html (+3ms) 
10:59:58   ├─ /seminary/klinicheskij-razbor-pacientov/index.html (+4ms) 
10:59:58   ├─ /seminary/rasshirennye-visceralnye-manipulyacii-nejroendokrinnyj-podhod-k-bryushnoj-polosti/index.html (+3ms) 
10:59:58   ├─ /seminary/voprosy-funkcionalnoj-biohimii-v-prikladnoj-kineziologii/index.html (+3ms) 
10:59:58   ├─ /seminary/index.html (+7ms) 
10:59:58   ├─ /sitemap/index.html (+8ms) 
10:59:58   ├─ /sotrudnichestvo-s-nami/index.html (+41ms) 
10:59:58   ├─ /specialisty/54/index.html (+4ms) 
10:59:58   ├─ /specialisty/63/index.html (+3ms) 
10:59:58   ├─ /specialisty/69/index.html (+3ms) 
10:59:58   ├─ /specialisty/58/index.html (+3ms) 
10:59:58   ├─ /specialisty/64/index.html (+3ms) 
10:59:58   ├─ /specialisty/70/index.html (+4ms) 
10:59:58   ├─ /specialisty/53/index.html (+4ms) 
10:59:58   ├─ /specialisty/65/index.html (+3ms) 
10:59:58   ├─ /specialisty/71/index.html (+3ms) 
10:59:58   ├─ /specialisty/56/index.html (+3ms) 
10:59:58   ├─ /specialisty/66/index.html (+3ms) 
10:59:58   ├─ /specialisty/60/index.html (+2ms) 
10:59:58   ├─ /specialisty/67/index.html (+3ms) 
10:59:58   ├─ /specialisty/55/index.html (+3ms) 
10:59:58   ├─ /specialisty/68/index.html (+3ms) 
10:59:58   ├─ /specialisty/57/index.html (+3ms) 
10:59:58   ├─ /specialisty/74/index.html (+5ms) 
10:59:58   ├─ /specialisty/61/index.html (+4ms) 
10:59:58   ├─ /specialisty/77/index.html (+4ms) 
10:59:58   ├─ /specialisty/79/index.html (+4ms) 
10:59:58   ├─ /specialisty/73/index.html (+3ms) 
10:59:58   ├─ /specialisty/76/index.html (+4ms) 
10:59:58   ├─ /specialisty/78/index.html (+4ms) 
10:59:58   ├─ /specialisty/80/index.html (+3ms) 
10:59:58   ├─ /specialisty/81/index.html (+3ms) 
10:59:58   ├─ /specialisty/82/index.html (+3ms) 
10:59:58   ├─ /specialisty/84/index.html (+4ms) 
10:59:58   ├─ /specialisty/85/index.html (+3ms) 
10:59:59   ├─ /specialisty/83/index.html (+4ms) 
10:59:59   ├─ /specialisty/index.html (+4ms) 
10:59:59   ├─ /statyi/90percent-narushenij-v-skeletno-myshechnoj-sisteme/index.html (+14ms) 
10:59:59   ├─ /statyi/beremennost-rody-i-vozmozhnosti-osteopatii/index.html (+9ms) 
10:59:59   ├─ /statyi/diagnostika-helikobakterioza-metodom-prikladnoj-kineziologii/index.html (+16ms) 
10:59:59   ├─ /statyi/diagnostika-i-lechenie-trematodnyh-invazij-u-vzroslyh/index.html (+8ms) 
10:59:59   ├─ /statyi/gipertenziya/index.html (+12ms) 
10:59:59   ├─ /statyi/giperventilyaciya-i-kraniosakralnyj-mehanizm/index.html (+13ms) 
10:59:59   ├─ /statyi/gryzha-pishevodnogo-otverstiya-diafragmy/index.html (+10ms) 
10:59:59   ├─ /statyi/institut-barralya-chem-unikalny-ego-programmy-obucheniya-dlya-specialistov-v-oblasti-zdorovya/index.html (+8ms) 
10:59:59   ├─ /statyi/institut-barralya-kak-obuchenie-visceralnym-tehnikam-pomogaet-stat-professionalom/index.html (+9ms) 
10:59:59   ├─ /statyi/ipolzovanie-kraniosakralnoj-terapii-dlya-snyatiya-ogranichenij-i-balansa-tela-pacienta-pri-ispolzovanii-massazhnyh-tehnik/index.html (+11ms) 
10:59:59   ├─ /statyi/ispolzovanie-meridianov-pri-kraniosakralnoj-terapii/index.html (+7ms) 
10:59:59   ├─ /statyi/istoriya-instituta-barralya-kak-vsyo-nachalos-i-chto-delaet-programmu-unikalnoj/index.html (+7ms) 
10:59:59   ├─ /statyi/izmeneniya-v-hiropraktike-v-svete-protomorfologii/index.html (+13ms) 
10:59:59   ├─ /statyi/izuchenie-ritmicheskih-dvizhenij-golovy-pozvolyayushih-opredelit-tretij-ritm/index.html (+17ms) 
10:59:59   ├─ /statyi/kislotno-shelochnoj-balans-i-lechenie-pacienta/index.html (+12ms) 
10:59:59   ├─ /statyi/klinicheskij-sluchaj-visceralnyh-manipulyacij-pri-podrostkovom-idiopaticheskom-skolioze/index.html (+18ms) 
10:59:59   ├─ /statyi/kraniosakralnaya-terapiya-chto-eto-za-metod-i-kak-on-rabotaet/index.html (+9ms) 
10:59:59   ├─ /statyi/kraniosakralnaya-terapiya-i-visceralnye-manipulyacii/index.html (+8ms) 
10:59:59   ├─ /statyi/krestcovo-podvzdoshnye-i-podvzdoshno-krestcovye-narusheniya/index.html (+15ms) 
10:59:59   ├─ /statyi/lechenie-allergij-v-hiropraktike/index.html (+12ms) 
10:59:59   ├─ /statyi/lechenie-bronhialnoj-astmy/index.html (+10ms) 
10:59:59   ├─ /statyi/metody-issledovaniya-mochi/index.html (+14ms) 
10:59:59   ├─ /statyi/mikrobiota-hronicheskaya-obstruktivnaya-bolezn-legkih/index.html (+7ms) 
10:59:59   ├─ /statyi/mikrobiota-vzaimodejstvie-mezhdu-mikrobiotoj-kishechnika-i-legkimi/index.html (+8ms) 
10:59:59   ├─ /statyi/narusheniya-polovoj-funkcii-u-muzhchin-predstavlenie-ob-andropauze-1/index.html (+14ms) 
10:59:59   ├─ /statyi/narusheniya-polovoj-funkcii-u-muzhchin-predstavlenie-ob-andropauze-2/index.html (+10ms) 
10:59:59   ├─ /statyi/narusheniya-polovoj-funkcii-u-muzhchin-predstavlenie-ob-andropauze-3/index.html (+39ms) 
10:59:59   ├─ /statyi/novyj-podhod-k-mozgu-strukturnyj-disbalans-i-usvoenie-pitatelnyh-veshestv/index.html (+13ms) 
10:59:59   ├─ /statyi/osnovnye-principy-osteopatii/index.html (+7ms) 
10:59:59   ├─ /statyi/otnoshenie-meridionalnoj-rnk-k-prikladnoj-kineziologii/index.html (+13ms) 
10:59:59   ├─ /statyi/pattern-perekrestnogo-polzaniya-i-myshechnyj-spazm/index.html (+10ms) 
10:59:59   ├─ /statyi/pishevoj-faktor-v-hiropraktike/index.html (+7ms) 
10:59:59   ├─ /statyi/povrezhdenie-perifericheskih-nervov-i-sindrom-zapyastnogo-tunnelya/index.html (+8ms) 
10:59:59   ├─ /statyi/predmet-prikladnoj-kineziologii/index.html (+6ms) 
10:59:59   ├─ /statyi/prezentaciya-novogo-podhoda-k-lecheniyu-povrezhdeniya-diskov/index.html (+7ms) 
10:59:59   ├─ /statyi/prikladnaya-kineziologiya-chto-eto-takoe-prostymi-slovami/index.html (+10ms) 
10:59:59   ├─ /statyi/prikladnaya-kineziologiya-i-myshechnoe-testirovanie/index.html (+11ms) 
10:59:59   ├─ /statyi/principy-balansirovaniya-myshc/index.html (+13ms) 
10:59:59   ├─ /statyi/problemy-kolennogo-sustava/index.html (+13ms) 
10:59:59   ├─ /statyi/provokaciya-shejnyh-pozvonkov/index.html (+11ms) 
10:59:59   ├─ /statyi/raskruchivanie-meridianov-dlya-invertirovaniya-techeniya-anemii/index.html (+7ms) 
10:59:59   ├─ /statyi/raskruchivanie-meridianov-pri-kontrakture-depyuitrena/index.html (+8ms) 
10:59:59   ├─ /statyi/respiratornye-funkcii-cherepa/index.html (+8ms) 
10:59:59   ├─ /statyi/sakroiliokalnye-i-iliosakralnye-narusheniya/index.html (+14ms) 
10:59:59   ├─ /statyi/seminar-po-kraniosakralnoj-terapii-1-otzyv/index.html (+12ms) 
10:59:59   ├─ /statyi/seminar-po-kraniosakralnoj-terapii-2-otzyv/index.html (+11ms) 
10:59:59   ├─ /statyi/shizofreniya/index.html (+11ms) 
10:59:59   ├─ /statyi/sindrom-tarzalnogo-tunnelya/index.html (+9ms) 
10:59:59   ├─ /statyi/sluchaj-lecheniya-enureza/index.html (+9ms) 
10:59:59   ├─ /statyi/terapevticheskoe-znachenie-visceralnoj-manipulyacii/index.html (+8ms) 
10:59:59   ├─ /statyi/upravlyat-vospaleniem-v-organizme-s-pomoshyu-kraniosakralnoj-terapii/index.html (+25ms) 
10:59:59   ├─ /statyi/uroki-kitajskogo-dlya-sovremennoj-hiropraktiki/index.html (+10ms) 
10:59:59   ├─ /statyi/ustalost-i-borba-s-neyu/index.html (+10ms) 
10:59:59   ├─ /statyi/visceralnaya-manipulyaciya/index.html (+10ms) 
10:59:59   ├─ /statyi/visceralnaya-manipulyaciya-pri-hronicheskih-bolyah/index.html (+9ms) 
10:59:59   ├─ /statyi/visceralnye-manipulyacii-i-tehniki-na-tkanyah-v-pediatricheskoj-praktike/index.html (+9ms) 
10:59:59   ├─ /statyi/visceralnye-tehniki-chto-eto-takoe-i-kak-oni-mogut-uluchshit-zdorove/index.html (+10ms) 
10:59:59   ├─ /statyi/vstrecha-pravoslavnoj-obshestvennosti-s-vrachom-osteopatom-pilyavskim-sergeem-orestovichem/index.html (+11ms) 
10:59:59   ├─ /statyi/vstuplenie-k-kraniosakralnoj-paradigme-apledzhera/index.html (+40ms) 
10:59:59   ├─ /statyi/vyhod-iz-dramaticheskogo-treugolnika-s-pozicii-psihoterapevticheskoj-kineziologii/index.html (+19ms) 
10:59:59   ├─ /statyi/vzglyad-na-hiropraktiku-s-tochki-zreniya-protomorfologii/index.html (+12ms) 
10:59:59   ├─ /statyi/zabolevaniya-zheludochno-kishechnogo-trakta-1/index.html (+8ms) 
10:59:59   ├─ /statyi/zabolevaniya-zheludochno-kishechnogo-trakta-2/index.html (+8ms) 
10:59:59   ├─ /statyi/zabolevaniya-zheludochno-kishechnogo-trakta-3/index.html (+9ms) 
10:59:59   ├─ /statyi/zabolevaniya-zheludochno-kishechnogo-trakta-4/index.html (+9ms) 
10:59:59   ├─ /statyi/zadnij-ilium-i-nejrolimfaticheskij-refleks/index.html (+9ms) 
10:59:59   ├─ /statyi/zhir-i-ego-utilizaciya-pod-kontrolem-holesterina/index.html (+11ms) 
10:59:59   ├─ /statyi/znachenie-tyazhelyh-metallov-v-razvitii-sindroma-hronicheskoj-ustalosti/index.html (+9ms) 
10:59:59   ├─ /statyi/index.html (+41ms) 
10:59:59   ├─ /svedeniya-ob-obrazovatelnoy-organizatsii/index.html (+51ms) 
10:59:59   ├─ /video/31/index.html (+13ms) 
10:59:59   ├─ /video/32/index.html (+5ms) 
10:59:59   ├─ /video/33/index.html (+4ms) 
10:59:59   ├─ /video/34/index.html (+4ms) 
10:59:59   ├─ /video/36/index.html (+4ms) 
10:59:59   ├─ /video/37/index.html (+3ms) 
10:59:59   ├─ /video/index.html (+5ms) 
10:59:59   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/prepodavatel/54/index.html (+4ms) 
10:59:59   ├─ /institut-apledzhera/prepodavatel/63/index.html (+6ms) 
10:59:59   ├─ /institut-barralya/prepodavatel/69/index.html (+3ms) 
10:59:59   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/prepodavatel/58/index.html (+3ms) 
10:59:59   ├─ /institut-apledzhera/prepodavatel/64/index.html (+3ms) 
10:59:59   ├─ /institut-barralya/prepodavatel/70/index.html (+3ms) 
10:59:59   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/prepodavatel/53/index.html (+3ms) 
10:59:59   ├─ /institut-apledzhera/prepodavatel/65/index.html (+3ms) 
10:59:59   ├─ /institut-barralya/prepodavatel/71/index.html (+3ms) 
10:59:59   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/prepodavatel/56/index.html (+4ms) 
10:59:59   ├─ /institut-apledzhera/prepodavatel/66/index.html (+3ms) 
10:59:59   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/prepodavatel/60/index.html (+3ms) 
10:59:59   ├─ /institut-apledzhera/prepodavatel/67/index.html (+3ms) 
10:59:59   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/prepodavatel/55/index.html (+2ms) 
10:59:59   ├─ /institut-apledzhera/prepodavatel/68/index.html (+2ms) 
10:59:59   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/prepodavatel/57/index.html (+2ms) 
10:59:59   ├─ /institut-apledzhera/prepodavatel/74/index.html (+3ms) 
10:59:59   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/prepodavatel/61/index.html (+3ms) 
10:59:59   ├─ /institut-apledzhera/prepodavatel/77/index.html (+3ms) 
10:59:59   ├─ /institut-apledzhera/prepodavatel/79/index.html (+4ms) 
10:59:59   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/prepodavatel/73/index.html (+3ms) 
10:59:59   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/prepodavatel/76/index.html (+3ms) 
10:59:59   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/prepodavatel/78/index.html (+3ms) 
10:59:59   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/prepodavatel/80/index.html (+3ms) 
10:59:59   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/prepodavatel/81/index.html (+3ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/prepodavatel/82/index.html (+3ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/prepodavatel/84/index.html (+3ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/prepodavatel/85/index.html (+4ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/prepodavatel/83/index.html (+11ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/psihokineziologiya/antistressovaya-kineziologiya-vvedenie-1/index.html (+8ms) 
11:00:00   ├─ /institut-barralya/visceralnye-tehniki/bryushnaya-polost-1/index.html (+6ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/specializirovannye/infekcii-i-psevdoinfekcii-vvedenie-v-gelmintologiyu-nematody/index.html (+40ms) 
11:00:00   ├─ /institut-apledzhera/primenenie-principov-akupunktury/ispolzovanie-meridianov-v-kranio-sakralnoj-terapii-1/index.html (+12ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/korrekciya-strukturnyh-narushenij-osteoprakticheskimi-i-myshechno-energeticheskimi-tehnikami/korrekciya-strukturnyh-narushenij-tazovogo-regiona-i-nizhnih-konechnostej/index.html (+6ms) 
11:00:00   ├─ /institut-apledzhera/kraniosakralnaya-terapiya/kraniosakralnaya-terapiya-1/index.html (+13ms) 
11:00:00   ├─ /institut-apledzhera/dolgoletie/kraniosakralnaya-terapiya-dlya-omolozheniya-i-dolgoletiya/index.html (+8ms) 
11:00:00   ├─ /institut-apledzhera/imunnyj-otvet/kraniosakralnaya-terapiya-i-immunnyj-otvet/index.html (+8ms) 
11:00:00   ├─ /institut-apledzhera/kraniosakralnaya-terapiya-specializirovannye/kraniosakralnaya-terapiya-i-zhiznennyj-cikl/index.html (+8ms) 
11:00:00   ├─ /institut-apledzhera/pediatriya-akusherstvo-i-novorozhdennye/kraniosakralnaya-terapiya-v-pediatrii-1/index.html (+6ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/kurs-po-kitajskoj-medicine-s-pozicij-prikladnoj-kineziologii/meridiany-kitajskaya-klassicheskaya-medicina-s-pozicii-prikladnoj-kineziologii-i-nevrologii-nejro-tkm-1/index.html (+8ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/massazh/miofascialnyj-i-bukkalnyj-massazh-lica/index.html (+9ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/prikladnaya-kineziologiya-dlya-fitnesa/myshechnoe-testirovanie-mmt-podhody-k-diagnostike-i-algoritmy-raboty-s-myshcami/index.html (+6ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/prikladnaya-kineziologiya/osnovy-manualnogo-myshechnogo-testirovaniya/index.html (+9ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/pereprogrammirovanie-nejroreceptornyh-zon-v-pk/seminar-1/index.html (+6ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/vibracionnaya-medicina/stimulyaciya-zhiznennoj-sily-kletki-1/index.html (+4ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/postdiplomnye-programmy-po-prikladnoj-kineziologii/strukturnaya-sostavlyayushaya-treugolnika-zdorovya/index.html (+9ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/vebinary-i-mezhseminarskie-vstrechi-ikpk/yadra-mozga-nevrologicheskij-podhod-k-diagnostike-i-funkcionalnoj-korrekcii/index.html (+9ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/psihokineziologiya/antistressovaya-kineziologiya-2/index.html (+6ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/prikladnaya-kineziologiya-dlya-fitnesa/diagnostika-prichin-oslableniya-myshc-i-algoritm-raboty-so-slabymi-myshcami/index.html (+5ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/specializirovannye/disfunkcii-yader-cherepno-mozgovyh-nervov/index.html (+18ms) 
11:00:00   ├─ /institut-apledzhera/primenenie-principov-akupunktury/ispolzovanie-meridianov-v-kranio-sakralnoj-terapii-2/index.html (+5ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/korrekciya-strukturnyh-narushenij-osteoprakticheskimi-i-myshechno-energeticheskimi-tehnikami/korrekciya-strukturnyh-narushenij-poyasnichnogo-grudnogo-otdelov-pozvonochnika-i-grudnoj-kletki/index.html (+3ms) 
11:00:00   ├─ /institut-apledzhera/kraniosakralnaya-terapiya/kraniosakralnaya-terapiya-2/index.html (+9ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/kurs-po-kitajskoj-medicine-s-pozicij-prikladnoj-kineziologii/meridiany-kitajskaya-klassicheskaya-medicina-s-pozicii-prikladnoj-kineziologii-i-nevrologii-nejro-tkm-2/index.html (+6ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/massazh/miofascialnyj-massazh-tela-armoplastika/index.html (+11ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/pereprogrammirovanie-nejroreceptornyh-zon-v-pk/seminar-2-srednij-uroven/index.html (+7ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/prikladnaya-kineziologiya/strukturnaya-sostavlyayushaya-treugolnika-zdorovya-obshie-diagnosticheskie-i-lechebnye-procedury-2/index.html (+9ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/prikladnaya-kineziologiya-dlya-fitnesa/bolevye-sindromy-i-rabota-s-nimi/index.html (+6ms) 
11:00:00   ├─ /institut-apledzhera/pediatriya-akusherstvo-i-novorozhdennye/csp-2-kraniosakralnaya-terapiya-v-pediatrii-2/index.html (+6ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/postdiplomnye-programmy-po-prikladnoj-kineziologii/disfunkciya-visochno-nizhnechelyustnogo-sustava-vnchs/index.html (+7ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/specializirovannye/gelmintozy-nematodozy-cestodozy-trematodozy/index.html (+9ms) 
11:00:00   ├─ /institut-apledzhera/primenenie-principov-akupunktury/ispolzovanie-meridianov-v-kranio-sakralnoj-terapii-3/index.html (+7ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/korrekciya-strukturnyh-narushenij-osteoprakticheskimi-i-myshechno-energeticheskimi-tehnikami/korrekciya-strukturnyh-narushenij-shejnogo-otdela-pozvonochnika-pleche-lopatochnogo-regiona-i-verhnih-konechnostej/index.html (+4ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/kurs-po-kitajskoj-medicine-s-pozicij-prikladnoj-kineziologii/meridiany-kitajskaya-klassicheskaya-medicina-s-pozicii-prikladnoj-kineziologii-i-nevrologii-nejro-tkm-3/index.html (+16ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/massazh/miofascialnyj-massazh-tela-zhenskij-massazh/index.html (+8ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/vebinary-i-mezhseminarskie-vstrechi-ikpk/pereprogrammirovanie-nejroreceptornyh-polej-p-dtr/index.html (+6ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/pereprogrammirovanie-nejroreceptornyh-zon-v-pk/seminar-1-prodvinutyj-uroven/index.html (+6ms) 
11:00:00   ├─ /institut-apledzhera/kraniosakralnaya-terapiya/somato-emocionalnoe-osvobozhdenie-1/index.html (+10ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/prikladnaya-kineziologiya/strukturnaya-sostavlyayushaya-treugolnika-zdorovya-obshie-diagnosticheskie-i-lechebnye-procedury/index.html (+30ms) 
11:00:00   ├─ /institut-apledzhera/primenenie-principov-akupunktury/ispolzovanie-meridianov-v-kranio-sakralnoj-terapii-4/index.html (+7ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/massazh/karta-patologij/index.html (+6ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/specializirovannye/korrekciya-shramov/index.html (+19ms) 
11:00:00   ├─ /institut-apledzhera/kraniosakralnaya-terapiya-specializirovannye/kraniosakralnaya-terapiya-za-predelami-osnovaniya-cherepa/index.html (+6ms) 
11:00:00   ├─ /institut-klinicheskoy-prikladnoy-kineziologii/pereprogrammirovanie-nejroreceptornyh-zon-v-pk/seminar-4-nejropatii-s-pozicii-nejroreceptornyh-polej/index.html (+8ms) 
11:00:00   ├─ /institut-apledzhera/kraniosakralnaya-terapiya/somato-emocionalnoe-osvobozhdenie-2/index.html
Command failed: npx astro build --outDir /private/tmp/ikpk-widget-probe-V2Z7Bu
(node:81238) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
(Use `node --trace-warnings ...` to show where the warning was created)
(node:81497) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
(Use `node --trace-warnings ...` to show where the warning was created)
ENOSPC: no space left on device, mkdir '/private/tmp/ikpk-widget-probe-V2Z7Bu/institut-apledzhera/kraniosakralnaya-terapiya/somato-emocionalnoe-osvobozhdenie-2/'
  Location:
    /Users/pgorbachev/projects/private/ikpk/.claude/worktrees/chat-entry-impl-20261021/web/node_modules/astro/dist/core/build/generate.js:438:3
  Stack trace:
    at async Object.mkdir (node:internal/fs/promises:856:10)
    at async generatePages (file:///Users/pgorbachev/projects/private/ikpk/.claude/worktrees/chat-entry-impl-20261021/web/node_modules/astro/dist/core/build/generate.js:159:11)
    at async Object.buildApp (file:///Users/pgorbachev/projects/private/ikpk/.claude/worktrees/chat-entry-impl-20261021/web/node_modules/vite/dist/node/chunks/node.js:33477:5)
    at async viteBuild (file:///Users/pgorbachev/projects/private/ikpk/.claude/worktrees/chat-entry-impl-20261021/web/node_modules/astro/dist/core/build/static-build.js:63:3)
    at async AstroBuilder.run (file:///Users/pgorbachev/projects/private/ikpk/.claude/worktrees/chat-entry-impl-20261021/web/node_modules/astro/dist/core/build/index.js:202:7)

```

# Test source

```ts
  13  |  * поведения в трёх состояниях адреса загрузчика и в двух годах, причём объявляет
  14  |  * публикуемыми оба состояния, где страница выглядит по-разному. Значит на единственной
  15  |  * сборке ровно одна ветвь имеет предмет, а остальные остались бы без построимого красного
  16  |  * состояния — и «законное состояние» с «зелёным гейтом» опять стали бы недостижимы
  17  |  * одновременно.
  18  |  *
  19  |  * Приём не выдуман здесь: спека применяет его сама к году сборки — «проверка идёт на ДВУХ
  20  |  * СБОРКАХ, различающихся `BUILD_YEAR`, потому что механизма подмены системных часов сборки
  21  |  * в репозитории нет». К трём состояниям конфигурации спека того же вывода не сделала, и это
  22  |  * названо находкой в передаче; здесь приём просто распространён.
  23  |  *
  24  |  * ── ЦЕНА ИЗМЕРЕНА, А НЕ ОЦЕНЕНА ─────────────────────────────────────────────
  25  |  * `npx astro build --outDir <вне репозитория>` на этом дереве — **6,3 с** и 91 МБ (замер
  26  |  * 24.08.2026, node 24.13.0, тёплый кэш vite). Это НЕ `npm run build`: тот идёт 1 мин 14 с,
  27  |  * потому что делает ещё `prebuild` (производные картинок) и `pagefind`. Производные пробной
  28  |  * сборке нужны уже готовыми — она их не пересобирает, поэтому вызывать её можно только
  29  |  * ПОСЛЕ обычной сборки. Отсюда место файлов-потребителей: `vitest.build.config.ts`, который
  30  |  * запускается скриптом `test:build` сразу за `npm run build`.
  31  |  *
  32  |  * ── КАТАЛОГ УДАЛЯЕТСЯ, И ЭТО НЕ АККУРАТНОСТЬ ────────────────────────────────
  33  |  * Одна пробная сборка занимает **91 МБ** (образы из `public/` копируются целиком, флага
  34  |  * «не копировать» у Astro нет). Первая редакция этого модуля каталог не удаляла, и за одну
  35  |  * сессию накопилось **59 каталогов, 5,4 ГБ** — диск кончился посреди работы, и `eslint`
  36  |  * упал с «no space left on device». То есть проверка ломала не свой предмет, а машину, на
  37  |  * которой шла.
  38  |  *
  39  |  * Поэтому по умолчанию модуль читает все страницы в память и каталог УДАЛЯЕТ сразу:
  40  |  * потребителю HTML нужен, а дерево — нет. Дерево остаётся на диске только когда его
  41  |  * действительно надо раздавать (`keepOnDisk`), и тогда удалить его обязан потребитель —
  42  |  * `dispose()`.
  43  |  *
  44  |  * ── ПОЧЕМУ КАТАЛОГ ВНЕ РЕПОЗИТОРИЯ ──────────────────────────────────────────
  45  |  * Корень сборочного вывода внутри репозитория пришлось бы вписать и в `.gitignore`, и в
  46  |  * закрытый перечень корней у `./bin/check-spec-refs` (он сверяет их с `.gitignore` и
  47  |  * отказывается при расхождении), и в реестр вхождений исполняемого вывода, который требует
  48  |  * ДВА собранных дерева. Пробная сборка ничего из этого не касается, потому что живёт в
  49  |  * каталоге операционной системы и не является артефактом проекта.
  50  |  */
  51  | 
  52  | const WEB = join(import.meta.dirname, '..', '..');
  53  | 
  54  | export interface ProbeBuild {
  55  |   /**
  56  |    * Корень пробной сборки на диске либо `null`, если дерево уже удалено.
  57  |    *
  58  |    * `null` — обычное состояние: страницы прочитаны в память, а 91 МБ дерева больше не
  59  |    * нужны. Не `null` только при `keepOnDisk`, и тогда потребитель обязан вызвать
  60  |    * `dispose()`.
  61  |    */
  62  |   readonly root: string | null;
  63  |   /** Страницы: путь относительно корня → разметка. */
  64  |   readonly pages: Map<string, string>;
  65  |   /** Чем сборка отличалась от боевой — для сообщений об отказе. */
  66  |   readonly label: string;
  67  |   /** Удалить дерево. Идемпотентно; на уже удалённом ничего не делает. */
  68  |   dispose(): void;
  69  | }
  70  | 
  71  | export interface ProbeOptions {
  72  |   /**
  73  |    * Оставить дерево на диске.
  74  |    *
  75  |    * Нужно только тем потребителям, которые дерево РАЗДАЮТ (браузерные прогоны). Всем
  76  |    * остальным хватает разметки в памяти, а 91 МБ на сборку при семи сборках — это 637 МБ
  77  |    * за прогон, накапливающиеся между прогонами.
  78  |    */
  79  |   readonly keepOnDisk?: boolean;
  80  | }
  81  | 
  82  | /**
  83  |  * Собрать сайт с подставленным окружением.
  84  |  *
  85  |  * Ключ со значением `undefined` из окружения УДАЛЯЕТСЯ, а не выставляется пустым: спека
  86  |  * называет пустое значение и отсутствие ключа одним состоянием, но проверять их надо
  87  |  * обоими способами, иначе реализация, различающая их, пройдёт незамеченной.
  88  |  */
  89  | export function buildProbe(
  90  |   label: string,
  91  |   env: Record<string, string | undefined>,
  92  |   options: ProbeOptions = {},
  93  | ): ProbeBuild {
  94  |   const root = mkdtempSync(join(tmpdir(), 'ikpk-widget-probe-'));
  95  |   const childEnv: Record<string, string> = {};
  96  |   for (const [key, value] of Object.entries(process.env))
  97  |     if (value !== undefined) childEnv[key] = value;
  98  |   for (const [key, value] of Object.entries(env)) {
  99  |     if (value === undefined) delete childEnv[key];
  100 |     else childEnv[key] = value;
  101 |   }
  102 | 
  103 |   try {
  104 |     execFileSync('npx', ['astro', 'build', '--outDir', root], {
  105 |       cwd: WEB,
  106 |       env: childEnv,
  107 |       stdio: ['ignore', 'pipe', 'pipe'],
  108 |       encoding: 'utf-8',
  109 |       timeout: 10 * 60 * 1000,
  110 |     });
  111 |   } catch (error) {
  112 |     const e = error as { stdout?: string; stderr?: string; message?: string };
> 113 |     throw new Error(
      |           ^ Error: пробная сборка «non-demo preview payment plus chat» не собралась — это «измерить не удалось», а не «нарушений нет».
  114 |       `пробная сборка «${label}» не собралась — это «измерить не удалось», а не ` +
  115 |         `«нарушений нет».\n${e.stderr ?? ''}\n${e.stdout ?? ''}\n${e.message ?? ''}`,
  116 |       { cause: error },
  117 |     );
  118 |   }
  119 | 
  120 |   if (!existsSync(root) || !statSync(root).isDirectory())
  121 |     throw new Error(`пробная сборка «${label}» не создала каталога вывода '${root}'`);
  122 | 
  123 |   const pages = new Map<string, string>();
  124 |   for (const file of walkFiles(root, ['.html']))
  125 |     pages.set(file.slice(root.length).replaceAll('\\', '/'), readFileSync(file, 'utf-8'));
  126 | 
  127 |   // Пустой набор — «не выполнено», а не «нарушений нет»: все утверждения об отсутствии
  128 |   // ниже тривиально верны на пустом выводе. Каталог при этом всё равно убираем: иначе
  129 |   // отказ оставляет 91 МБ мусора на каждой неудачной сборке.
  130 |   if (pages.size === 0) {
  131 |     rmSync(root, { recursive: true, force: true });
  132 |     throw new Error(`пробная сборка «${label}» не дала ни одной html-страницы: предмета нет`);
  133 |   }
  134 | 
  135 |   let alive = options.keepOnDisk === true;
  136 |   if (!alive) rmSync(root, { recursive: true, force: true });
  137 |   const probe: ProbeBuild = {
  138 |     get root() {
  139 |       return alive ? root : null;
  140 |     },
  141 |     pages,
  142 |     label,
  143 |     dispose() {
  144 |       if (!alive) return;
  145 |       alive = false;
  146 |       rmSync(root, { recursive: true, force: true });
  147 |     },
  148 |   };
  149 |   return probe;
  150 | }
  151 | 
  152 | /**
  153 |  * Пробный адрес загрузчика.
  154 |  *
  155 |  * Домен верхнего уровня `.invalid` зарезервирован и не разрешается НИКОГДА — то есть
  156 |  * пробная сборка, случайно попавшая в браузер, наружу не уйдёт. Портальный адрес заказчика
  157 |  * здесь ставить нельзя: пробный вывод живёт в каталоге операционной системы, и его файлы
  158 |  * переживают прогон.
  159 |  */
  160 | export const PROBE_CHAT_LOADER_SRC = 'https://chat-loader.invalid/probe/loader_probe.js';
  161 | 
```