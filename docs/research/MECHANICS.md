# Minecraft Java Edition: mechanica en wat BunkCraft nog mist

Onderzoeksdocument (oktober 2026). Bron: vooral minecraft.wiki, opgehaald op 2026-10-02. De huidige Java-release is **26.3** (15 september 2026; Mojang is overgestapt van "1.21.x" naar jaar-nummering: 26.1 op 24 maart 2026, 26.2 op 16 juni, 26.3 op 15 september; 1.21.11 is de laatste oude nummering). Alle getallen hieronder gelden voor die release tenzij anders vermeld.

**Leeswijzer.** Per onderdeel: *hoe het werkt* (exacte regels), *status in BunkCraft* (Aanwezig / Gedeeltelijk / Ontbreekt, gecontroleerd in de code op `feature/bunkcraft-engine`) en *wat nodig is* (systemen + effort S/M/L/XL). "onzeker" = niet door de wiki-pagina's bevestigd die ik opgehaald heb (geheugen of tegenstrijdige bron); gebruik die getallen pas na controle op minecraft.wiki. Mojang-assets blijven buiten de repo (zie `CLAUDE.md`); dit document bevat alleen regels en getallen.

**Effort:** S = < 1 dag, M = 1–3 dagen, L = 1–2 weken, XL = > 2 weken of nieuw subsysteem.

**Opmerkelijke versieverschillen t.o.v. wat veel mensen weten** (relevant voor faithfulness):
- Game rules zijn hernoemd naar snake_case in 1.21.11 (`keep_inventory`, `advance_time` = oude `doDaylightCycle`, `spawn_mobs`, `respawn_radius`, `random_tick_speed`, `players_sleeping_percentage`, `mob_griefing`, `natural_health_regeneration`).
- Spawn chunks bestaan niet meer (verwijderd in 1.21.9).
- Koperen gereedschap (mining-snelheid 5, tussen steen en ijzer) en koperen harnas bestaan (1.21.9).
- Spears (speren) met Lunge-enchantment zijn nieuw (oppervlakkig behandeld, onzeker).
- Nieuwe/aangekondigde biomes (Pale Garden, Sulfur Caves; Ice Caves "upcoming"): niet nodig voor BunkCraft.

**Kernobservatie BunkCraft vs. vanilla:** de wereld is 128 hoog (`CHUNK_HEIGHT = 128`, `SEA_LEVEL = 62`), vanilla is y −64..320 (zeeniveau 63). Alles wat in vanilla op y −64..0 gebeurt (deepslate, diamant op −59, ancient cities, trial chambers) moet voor BunkCraft herschaald of geschrapt worden. Er zijn nu 8 mobs, 8 biomes, ~80 blokken, ~50 items.

---

## 1. Survival-kern

### 1.1 Health, honger, saturatie, uitputting

| Regel | Waarde |
|---|---|
| Max health / honger | 20 / 20 (hartjes ×2) |
| Start-saturatie | 5 |
| Uitputting per actie | sprinten 0,1/m, springen 0,05, sprint-springen 0,2, zwemmen 0,01/m, blok breken 0,005, melee-aanval 0,1, geblokkeerde/ontvangen schade 0,1, Hunger-effect 0,005 per tick per level |
| Uitputting omzetten | bij ≥ 4,0: uitputting −4, dan saturatie −1 (of honger −1 als saturatie 0) |
| Natuurlijke regen | honger ≥ 18: 1 HP per 80 ticks (kost 6,0 uitputting per HP) |
| Saturation boost (Java) | honger 20 én saturatie > 0: elke 10 ticks 1 HP, verbruikt 1,5 saturatie per HP |
| Verhongeren (honger 0) | 1 HP per 80 ticks; Easy stopt bij 10 HP, Normal bij 0,5 HP, Hard geen grens |
| Sprinten | alleen bij honger > 6 |
| Eten | 32 ticks (1,6 s) |

Voedseltabel (honger / saturatie, Java; uit geheugen, gecontroleerd op consistentie met de wiki-maxima: cake 14, cooked porkchop/steak/pumpkin pie 8):

| Item | H | S | Item | H | S |
|---|---|---|---|---|---|
| Gebakken varken, steak | 8 | 12,8 | Gebakken kip | 6 | 7,2 |
| Gebakken schaap, gebakken zalm | 6 | 9,6 | Brood, gebakken aardappel, gebakken kabeljauw/konijn | 5 | 6 |
| Appel | 4 | 2,4 | Gouden appel | 4 | 9,6 |
| Gouden wortel | 6 | 14,4 | Wortel | 3 | 3,6 |
| Rauw varken/rund | 3 | 1,8 | Rauwe kip/schaap | 2 | 1,2 (kip: 30% Hunger-effect) |
| Rot vlees | 4 | 0,8 (80% Hunger-effect) | Spinnenoog | 2 | 3,2 (Poison) |
| Meloenschijf | 2 | 1,2 | Koekje | 2 | 0,4 |
| Pompoentaart | 8 | 4,8 | Taart | 14 (7 plakken) | 2,8 per plak |

**Status:** Aanwezig (honger/saturatie/uitputting/regen/verhongeren/sprintgrens in `PlayerStats.ts`, vleesitems in `ItemRegistry.ts`). Gedeeltelijk: er is geen brood, appel, wortel, gouden appel, taart; saturation boost bestaat al (hunger = 20 + saturatie → 10 ticks). Verhongeren stopt bij Normal op 1 HP alleen buiten hardcore, geen Easy-grens (komt met difficulty).
**Nodig:** voedselitems komen met landbouw (§3). S per voedselgroep.

### 1.2 Schade en dood

| Bron | Regel |
|---|---|
| Vallen | `schade = valafstand − 3` (afgerond omhoog door Java); Feather Falling −3 EPF/level; water/web/slime/honing/ladder/zoete bessen resetten; max. levend 42 blokken (39 HP) in vanilla |
| Verdrinken | lucht 300 ticks; daarna 2 HP per 20 ticks (wiki-samenvatting zegt "2 HP per 10 ticks"; code gebruikt 2 per seconde: onzeker welke juist is, verifiëren) |
| Vuur | 1 HP/s (soul fire 2); brandduur 8 s bij vuurblok, lava zet 15 s in brand; water/regen blust |
| Lava | 4 HP per 10 ticks (de wiki geeft "4 per seconde" in samenvatting, onzeker), brandt 15 s |
| Magma block / campfire | 1 HP/s (magma niet bij sneaken) |
| Cactus | 1 HP per hit, invulnerability 10 ticks |
| Stikken | 1 HP per 10 ticks in een vol blok |
| Void | 4 HP per 10 ticks onder y < −64 (BunkCraft: onder wereldbodem; zie opmerking) |
| Bliksem | 5 HP + brand, zet blokken in brand |
| Explosie | schade = f(blootstelling, afstand tot kracht); TNT 4, creeper 3 (geladen 6), bed in Nether/End 5, end crystal 6 |
| Moeilijkheid | veel mobschade: Easy `min(D, D/2+1)`, Normal `D`, Hard `1,5·D` |
| Invulnerability | 10 ticks na een treffer; binnen 10 ticks telt alleen het extra verschil bij een zwaardere klap; dode-ticks 20 |

**Status:** Aanwezig (alle bronnen behalve bliksem, magma, vallen-reducties; onzeker over drownintervallen). Let op: `GAMEPLAY.md` zegt void onder y = −64 terwijl de wereld op y 0..127 ligt: controleer dat de void-grens in `PlayerStats` echt bereikbaar is (anders is void-schade nooit actief).
**Nodig:** magma-blok, web, slime-blok zijn blokdefinities (S). Schade-pijplijn in `Player`/`PlayerStats.damage()` uitbreiden met types, armor en effects (zie §2).

### 1.3 XP en levels

| Regel | Waarde |
|---|---|
| XP voor level L→L+1 | L ≤ 15: `2L+7`; L 16–30: `5L−38`; L ≥ 31: `9L−158` |
| Totaal XP tot level | L ≤ 16: `L²+6L`; 17–31: `2,5L²−40,5L+360`; ≥ 32: `4,5L²−162,5L+2220` (level 30 = 1395 XP) |
| Orbs | waarden 1, 3, 7, 17, 37, 73, 149, 307, 617, 1237, 2477 (onzeker: de rij komt uit geheugen); trekken naar speler binnen 7,25 blokken, verdwijnen na 5 min (6000 ticks) |
| Bronnen | monster 5 (zombie, skeleton, creeper: 5; spin 5; enderman 5; witch 5; slime = grootte), dier 1–3, fokken 1–7, vissen 1–6, handel 3–6, kolenerts 0–2, diamant/emerald 3–7, redstone 1–5, lapis 2–5, smelten (ijzer 0,7, goud 1,0, gebakken vlees 0,35, glas 0,1: onzeker), vuurmen: Ender Dragon 12 000 eerste keer |
| Dood | laat `min(7·level, 100)` XP vallen, rest verdwijnt (`keep_inventory` bewaart alles) |
| Mending / bottle o' enchanting | Mending herstelt 2 durability per XP; fles geeft 3–11 XP (onzeker) |

**Status:** Ontbreekt (geen XP-orb, geen XP-balk, geen level-weergave; `Advancements.ts` heeft er niets mee te maken).
**Nodig:** `XpOrb` entity (zoals `ItemEntity` + magnet, merge, despawn), `PlayerStats.xp/level`, HUD-balk, drops uit mob-kill/ertsen/smelten, opslag in `WorldMeta`/player-record, protocol-bericht. **M.** Basis voor enchanting (§4).

### 1.4 Dood, respawn, spawnpunt, bedden, slapen

| Regel | Waarde |
|---|---|
| Respawn | op wereldspawn of bed/respawn anchor; wereldspawn zoekt binnen `respawn_radius` (standaard 10) |
| Bed zetten | rechtsklik zet spawnpunt (ook overdag, "Respawn point set"); verwijderd/geblokkeerd bed: terug naar wereldspawn |
| Spawn naast bed | eerst de 2 blokken naast de kop in kijkrichting; zijn alle 10 omliggende geblokkeerd, dan boven de kop, dan boven de voet |
| Slapen toegestaan | als interne sky light ≤ 11: helder weer ~ ticks 12542–23459, regen/onweer: eerder |
| Slaapduur | 101 ticks (5,05 s) tot de nacht overgaat |
| Monsters | vijandige mobs binnen 8 blokken horizontaal en 5 verticaal van de kop blokkeren slapen |
| Multiplayer | `players_sleeping_percentage` (standaard 100); slapers tellen mee, tijd gaat naar ochtend (tick 0) en weer wordt helder |
| Nether/End | bed explodeert met kracht 5 |
| Phantoms | 72 000 ticks (3 dagen) niet geslapen of gestorven → spawnen 's nachts |
| Val op bed | −50% valschade |

**Status:** Gedeeltelijk: dood/respawn/doodscherm/hardcore aanwezig, spawnpunt is vast; bed ontbreekt (items en blokken zijn er niet; block states kunnen een 2-bloks bed aan, net als `OAK_DOOR`; `ROADMAP.md` zegt dat het kan).
**Nodig:** bed-blok (2 blokken, richting, kleur uit wol), spawnpunt per speler in `WorldMeta`/server-player-record, `Game.sleep()` (tijd versnellen in `DayCycle` en server-tijd), regel voor slapers in multiplayer-protocol, "Respawn point set"-bericht. **M.** Voorwaarde voor phantoms en insomnia.

### 1.5 Moeilijkheidsgraden en game rules

| Difficulty | Effecten |
|---|---|
| Peaceful | geen vijandige spawns (behalve shulker/draak), honger vult, snelle regen |
| Easy | mobschade `min(D, D/2+1)`; geen deurbreken; cave spiders vergiftigen niet; verhongeren tot 10 HP |
| Normal | basis; zombie zet 50% villager om; verhongeren tot 0,5 HP |
| Hard | 1,5·D; zombies breken deuren, roepen versterking, 100% omzetting; verhongeren doodt |
| Regional difficulty | 0,00–6,75, afhankelijk van wereldmoeilijkheid, tijd dat de chunk bewoond is, totaal dagen, maanfase: schaalt armor/wapen-kansen en speciale vaardigheden |

Game rules (standaard): `keep_inventory` false, `advance_time` true, `advance_weather` true, `spawn_mobs` true, `mob_griefing` true, `mob_drops` true, `natural_health_regeneration` true, `fall_damage`/`fire_damage`/`drowning_damage`/`freeze_damage` true, `random_tick_speed` 3, `respawn_radius` 10, `players_sleeping_percentage` 100.

**Status:** Ontbreekt (alleen game modes survival/creative/hardcore/spectator in `GameMode.ts`; difficulty-enum bestaat niet, komt wel in `MobTypes`/`EntityManager` als "darkness"-schaling).
**Nodig:** `Difficulty` in `WorldMeta` + server-env (`DIFFICULTY`), multiplier in `PlayerStats.damage()`, spawn-checks per difficulty, menu-selector. **S–M.** `GameRules`-object met `/gamerule`-commando via bestaande chat-commando's, in protocol. **S–M.**

**Bronnen §1:** minecraft.wiki/w/Hunger, /Damage, /Experience, /Bed, /Difficulty, /Game_rule, /Food, /Daylight_cycle.

---

## 2. Gevecht

### 2.1 Aanval, cooldown, crits, sweep, knockback

| Regel | Waarde |
|---|---|
| Aanvalssnelheid | `T = 20/speed` ticks voor volle cooldown; schade-schaal `0,2 + ((t+0,5)/T)²·0,8` (t = ticks sinds vorige swing, max 1) |
| Basisschade (Java) | zwaard 4 (hout/goud), 5 (steen), 6 (ijzer), 7 (diamant), 8 (netherite); speed 1,6 |
| Bijl | 7 (hout/goud), 9 (steen/ijzer/diamant), 10 (netherite: onzeker per materiaal); speed 0,8–1,0 (hout 0,8, steen 0,8, ijzer 0,9, diamant 1,0, onzeker voor goud/netherite) |
| Pikhouweel/schop/schoffel | pikhouweel 2–6, schop 2,5–6,5, schoffel 1 (speed varieert; onzeker); vuist 1 |
| Crit | vallend (niet op de grond, niet in water/ladder/blind/gesprint/mount) en cooldown > 84,8%: ×1,5 vóór enchants; geen crit bij sprintknockback-aanval |
| Sweep | zwaard, op de grond, cooldown ≥ 84,8%, geen sprint-knockback: 1 schade (+ Sweeping Edge: 50/67/75% van zwaardschade) aan omstanders (1 blok vanaf doelwit) |
| Knockback | basis 0,4; sprint-aanval levert +1 niveau; Knockback-enchant +1/level; verticaal alleen als doel op grond; Knockback Resistance (netherite 10% per stuk; iron golem/warden 100%) vermindert `v·(1−r)`; geen knockback tijdens invulnerability |
| Invulnerability | 10 ticks na een klap |
| Strength / Weakness | Strength +3 per level, Weakness −4 per level (melee) |
| Sharpness | +0,5 per level extra (+1 voor level I: `0,5·L+0,5`); Smite en Bane of Arthropods +2,5 per level |

### 2.2 Schilden

Rechtsklik, 5 ticks opwarmen; blokkeert melee, projectielen, explosies uit een halve cirkel vóór de speler; beweegt op sneaksnelheid; schild verliest durability gelijk aan geblokkeerde schade (afgerond, vanaf 3); durability 336; bijl blokkeert het schild 100 ticks (5 s); piercing arrows, bliksem, potions en vallen worden niet geblokkeerd. Recept: 6 planken + 1 ijzer.

### 2.3 Harnas

| Materiaal | Helm | Borst | Broek | Schoen | Totaal | Toughness |
|---|---|---|---|---|---|---|
| Leer | 1 | 3 | 2 | 1 | 7 | 0 |
| Koper | 2 | 4 | 5 | 1 | 12 | 0 |
| Goud | 2 | 5 | 3 | 1 | 11 | 0 |
| Chainmail | 2 | 5 | 4 | 1 | 12 (de wiki-samenvatting gaf 14: onzeker) | 0 |
| IJzer | 2 | 6 | 5 | 2 | 15 | 0 |
| Diamant | 3 | 8 | 6 | 3 | 20 | 2 per stuk |
| Netherite | 3 | 8 | 6 | 3 | 20 | 3 per stuk, +1 KB-weerstand |

Schildpadschelp: helm met 2 armor, Water Breathing 10 s. Elytra: geen armor. Formule (Java): `schade' = schade · (1 − min(20, max(armor/5, armor − 4·schade/(toughness+8))) / 25)`. Protection-enchants: EPF telt op, max 20, `schade'' = schade' · (1 − EPF/25)`; EPF per level: Protection 1, Fire/Blast/Projectile Protection 2 (specifieke bron), Feather Falling 3 (val); Resistance-effect −20% per level.

Durability (helm/borst/broek/schoen): leer 55/80/75/65, ijzer 165/240/225/195, diamant 363/528/495/429: onzeker (geheugen).

### 2.4 Enchantments (alle in 26.3, max level + effect + items)

| Enchant | Max | Effect | Items |
|---|---|---|---|
| Sharpness | V | +schade | zwaard, speer, bijl |
| Smite | V | +2,5/level vs. undead | idem + mace |
| Bane of Arthropods | V | +2,5/level vs. arthropods + Slowness IV | idem + mace |
| Protection | IV | −schade (EPF 1/lvl) | alle armor |
| Fire Protection | IV | minder vuur + kortere brand | armor |
| Blast Protection | IV | minder explosieschade en KB | armor |
| Projectile Protection | IV | minder projectiel | armor |
| Feather Falling | IV | minder valschade | boots |
| Respiration | III | langer ademen | helm |
| Aqua Affinity | I | geen mining-straf onder water | helm |
| Depth Strider | III | sneller in water | boots |
| Frost Walker | II | water → frosted ice | boots |
| Soul Speed | III | sneller op soul sand | boots |
| Swift Sneak | III | sneller sneaken | broek |
| Thorns | III | reflecteert schade (kost durability) | armor |
| Knockback | II | meer KB | zwaard, speer |
| Fire Aspect | II | zet in brand | zwaard, speer, mace |
| Looting | III | meer mobdrops (+1 max per level) | zwaard, speer |
| Sweeping Edge | III | sweep-schade (Java) | zwaard |
| Efficiency | V | snelheid +`L²+1` | gereedschap |
| Fortune | III | meer drops | gereedschap |
| Silk Touch | I | blok blijft zichzelf | gereedschap |
| Unbreaking | III | kans om geen durability te verliezen | bijna alles |
| Mending | I | repareert met XP | bijna alles |
| Power | V | +schade boog (25% per level+1... onzeker) | boog |
| Punch | II | meer KB | boog |
| Flame | I | vlam | boog |
| Infinity | I | pijlen niet verbruikt | boog |
| Multishot | I | 3 pijlen | kruisboog |
| Piercing | IV | pijl dringt door | kruisboog |
| Quick Charge | III | sneller laden | kruisboog |
| Impaling | V | meer schade vs. watermobs | trident |
| Loyalty | III | keert terug | trident |
| Riptide | III | lanceert speler in water/regen | trident |
| Channeling | I | bliksem bij onweer | trident |
| Density / Breach / Wind Burst | V / IV / III | mace: smash-schade / armor negeren / opwaartse boost | mace |
| Lunge | III | speer-spring, kost honger | speer |
| Luck of the Sea / Lure | III / III | betere vangst / snellere beet | hengel |
| Curse of Binding / Vanishing | I | niet uitdoen / verdwijnt bij dood | armor / bijna alles |

### 2.5 Potions en effecten

| Effect | Regel |
|---|---|
| Speed / Slowness | +20% / −15% snelheid per level (onzeker voor Slowness) |
| Haste / Mining Fatigue | mining-snelheid +20%/level; `0,3^min(L,4)` |
| Strength / Weakness | +3 / −4 schade per level |
| Instant Health / Damage | 4·2^L HP / 6·2^L (onzeker) |
| Regeneration | level I: 1 HP per 50 ticks, II per 25 |
| Poison | 1 HP per 25 ticks, stopt op 0,5 HP; Wither: doodt |
| Jump Boost, Resistance (−20%/lvl), Fire Resistance, Water Breathing, Invisibility, Night Vision, Absorption (4 HP/level), Health Boost, Saturation, Slow Falling, Levitation, Nausea, Blindness, Hunger, Darkness, Glowing, Luck, Conduit Power, Dolphin's Grace, Bad/Raid Omen, Hero of the Village, Wind Charged, Weaving, Oozing, Infested | zie wiki |

**Status gevecht:** Gedeeltelijk. Aanwezig: vuist 1, zwaarden 4–7 (in goud ook), bijlen 7–10 (`TOOL_BASE` in `ItemRegistry.ts`), knockback (`Mob.hurt`), sprint-bonus, invulnerability 10 ticks, boog + pijlen (kracht `(f²+2f)/3`, crit bij volle spanning), TNT en creeper-explosies, Poison-schade (`'poison'` in `DamageCause`). Ontbreekt: attack cooldown, melee-crits, sweep, schild, harnas (geen armor-slot of -bar), alle enchantments, status-effecten (alleen Poison-hack), kruisboog, trident, mace, speer, potions.
**Nodig:**
- Cooldown/crit/sweep: `attackSpeed` in `ItemRegistry`, cooldownmeter in HUD, crit-check in `Interaction`. **M.**
- Armor: 4 equipmentslots in `Inventory`, bar in HUD, formule in `PlayerStats.damage`, 3D-model of overlay in `MobRenderer`/third-person speler, recepten per materiaal, leer-drop van koe. **L.**
- Schild: blokkeer-status in `Player`, richting-check, durability, bijl-disable. **M.**
- Effect-systeem: `ActiveEffect[]` in `PlayerStats` + `Mob`, HUD-iconen, ticks, protocol. **L**, basis voor potions/brewing.
- Enchantments: NBT-achtig `enchants` veld op `ItemStack` (nu `{id,count}` zonder data → protocol, save en recept-rework). **XL** (enchant-data op stacks raakt Inventory, SaveSystem, protocol 4, UI-tooltips).
- Kruisboog/trident/mace: `M` per wapen na enchant-data; mace-schade: >1,5 blok val, +4 per blok (eerste 3), +2 (volgende 5), +1 (daarna), valschade geannuleerd (onzeker op details).

**Bronnen §2:** minecraft.wiki/w/Combat, /Armor, /Enchanting, /Effect, /Shield, /Sword, /Bow, /Knockback_(mechanic), /Damage.

---

## 3. Mijnen en blokken

### 3.1 Breken, gereedschap, drops

Formule: `snelheid = toolsnelheid · (efficiency>0 ? L²+1 : 0 erbij) · haste(1+0,2·L) · fatigue(0,3^min(L,4))`; ÷5 in de lucht, ÷5 onder water zonder Aqua Affinity (25× samen). Schade per tick `= snelheid / hardheid / (kan_oogsten ? 30 : 100)`; blok breekt bij cumulatief ≥ 1; breektijd naar boven op tick afgerond; instant als `snelheid/hardheid > 30`.

| Tier | Snelheid | Durability | Harvest-level |
|---|---|---|---|
| Hand | 1 | n.v.t. | alleen "geen tool nodig"-blokken |
| Hout | 2 | 59 | 0 |
| Steen | 4 | 131 | 1 |
| Koper (nieuw) | 5 | onzeker | 1 (onzeker) |
| IJzer | 6 | 250 | 2 |
| Diamant | 8 | 1561 | 3 |
| Netherite | 9 | 2031 | 3 |
| Goud | 12 | 32 | 0 |

Hardheid / blast resistance (benadering, vanilla-waarden uit geheugen; data-driven tabel in `BlockRegistry` volstaat): gras/dirt 0,5–0,6 / 0,5–0,6, zand 0,5, grind 0,6, steen 1,5 / 6, cobble 2 / 6, planken 2 / 3, logs 2, leaves 0,2, glas 0,3, wol 0,8, kolen/ijzer/goud/diamant-erts 3 (3), obsidiaan 50 / 1200, bedrock −1 / 3 600 000, water/lava 100, werkbank 2,5, oven 3,5, boekenkast 1,5, TNT 0 / 0, kist 2,5, ijs 0,5, sneeuwblok 0,2, netherrack 0,4. Gereedschapsvoorkeur: pikhouweel (steen/erts), bijl (hout), schop (grond/zand/grind/sneeuw), schoffel (leaves, hooi), zwaard (web, bamboo), schaar (leaves/wol/web).

**Fortune** (ertsen, `2/(L+2)` kans geen bonus, anders gelijkmatig multiplier 2..L+1: gemiddeld 1,33/1,75/2,2×), discrete drops (glowstone, meloen, redstone) +1 max per level, gewassen via binomiaal, grind-vuursteen 10% → 100% (Fortune III), leaves-sapling tot 10% (III). **Silk Touch** gaat voor Fortune. Bladeren: 5% (1/20) sapling, 0,5% apple (eik), stick 2%, schaar altijd leaves.

**Status:** Gedeeltelijk. Aanwezig: hardheid per blok (`BlockDef.hardness`), breektijdformule met ÷5 in lucht/water, tool tiers hout/steen/ijzer/diamant/goud met `minTier`, drop-regels (gras→aarde, steen→cobble, erts→item, leaves→stick, glas→niets), items zwevend/oppakken/mergen. Ontbreekt: Efficiency/Fortune/Silk Touch (hangt aan enchants), Haste/Fatigue, schaar, schoffel, kopertier, netherite, blast-resistance-tabel voor explosies (nu `explode` met eigen weerstand? onzeker: controleer `World.ts` explosie).
**Nodig:** per-blok `blastResistance` en `drops: LootTable`-verwijzing in `BlockDef`; Fortune/Silk via loot-functies (§4.9). **M** samen met loot-tabellen.

### 3.2 Zwaartekrachtblokken

Zand, grind, concrete powder, anvil, dragon egg: bij een blok-update, geplande tick van 2 ticks; als er niets steunbaars onder zit wordt het een `FallingBlock`-entity (versnelling 0,04/tick, demping 0,98), landt of valt in vloeistof/fakkels (slaat fakkels, planten kapot en dropt als item), anvil doet 2 schade per blok val (max 40). Zand dat landt op een fakkel breekt die.

**Status:** Ontbreekt (zand/grind staan stil; staat op `GAMEPLAY.md`-roadmap als "vallend zand en grind"). **Nodig:** `FallingBlock` entity + renderer (`InstancedMesh`), scheduled tick (hergebruik `LiquidSim`-queue), server-synchronisatie, save. **M.**

### 3.3 Random ticks en plantengroei

Random tick: elke tick kiest elke chunk-sectie (16³) in de simulatieafstand `random_tick_speed` (3) willekeurige blokken; elk blok heeft dus 3/4096 kans per tick (gemiddeld per ~68 s). Blokken met random-tick gedrag: gewassen, saplings, leaves (decay), gras/mycelium (verspreiden en afsterven), vuur, ijs/sneeuw, kelp/bamboo/riet/cactus, farmland (uitdrogen), wortelblokken, pompoen/meloen, nether wart, cauldron, paddenstoelen, lava (vuur starten).

| Plant | Regel |
|---|---|
| Sapling | random tick: licht ≥ 9 (de wiki-samenvatting noemde 8; onzeker) bij het sapling, stage 0→1 (kans 1/7 per random tick), dan boomgeneratie als er ruimte is; gemiddeld ~1 poging/minuut; bone meal 45% fase |
| Boomtypes | eik (stam 4–6, 10% "big oak" met takken), berk 5–7, spar (kegelvorm, 2×2 = enorm), jungle (2×2), acacia, dark oak (2×2), cherry, mangrove, pale oak |
| Leaves decay | `distance` tot dichtstbijzijnde log (max 6 stappen); zonder log binnen 6 en niet `persistent` (door speler geplaatst): verdwijnt bij random tick, kan drops geven |
| Tarwe/wortel/aardappel/bietwortel | `age 0–7` (bietwortel 0–3), random tick, licht ≥ 9, op farmland; groeikans `1/(floor(25/p)+1)` met punten p uit de 3×3 farmland eronder (1 per natte, 0,25 per droge; ×0,5 bij rijen met zelfde gewas; onzeker op exacte punten); bone meal +2–5 fases; zaad uit gras 12,5% |
| Farmland | gehydrateerd bij water binnen 4 blokken horizontaal (diagonaal inbegrepen), zelfde of 1 hoger niveau; vochtigheid 0–7, regen hydrateert; droog zonder gewas wordt dirt; vertrapt door springen/vallen (> 0,5 blok), mobs < 0,512 m³ vertrappen niet; vaste blokken erboven maken er dirt van |
| Suikerriet | `age 0–15`, bij random tick op age 15 groeit er één bij (max 3 hoog); naast water (ook gedekt); doet het zonder licht; gemiddeld ~18 min per blok (Java); bone meal werkt niet (Java) |
| Cactus | zelfde leeftijdsmodel, max 3, breekt als er een blok naast staat; schade bij aanraking |
| Bamboo | groeit tot 12–16, random tick |
| Kelp | `age 0–25`, boven water, bone meal +1 |
| Pompoen/meloen | stam groeit, vrucht naast de stam |
| Gras verspreiden | dirt met gras ernaast en licht ≥ 4 erboven wordt gras; gras sterft onder een vol blok |

**Bone meal:** gewas +2–5 fases, sapling 45%, paddenstoel 40% enorm, gras laat planten groeien, kelp +1, geen riet (Java). Bronnen: skeleton (0–2 bones), composter, kisten, vissen 5%.
**Composter:** 8 niveaus; kans per item: 30% (zaden, leaves, saplings, gras, kelp), 50% (cactus, meloenschijf, suikerriet, vines, bamboo?), 65% (appel, wortel, bloem, paddenstoel, aardappel), 85% (brood, bakaardappel, hooibaal, taart 100%); eerste item in lege composter geeft altijd niveau; bij niveau 7→8 geeft het 1 bone meal; rechtsklik bij niveau 8 pakt bone meal.

**Status:** Ontbreekt volledig (geen random ticks in `World.ts`; geen farmland, geen saplings, geen gewassen, geen riet; bomen/cactus alleen via `TerrainGenerator`; leaves verdwijnen nooit). `bone` bestaat als item maar heeft geen functie behalve voedsel voor wolven? (niet aanwezig).
**Nodig:** **kernprerequisite**: `RandomTicker` in `World` (per chunk per sectie 3 blokken, via lookup `HAS_RANDOM_TICK[id]`, server-authoritatief in multiplayer, simulatieafstand ~4–6 chunks); `meta` byte voor `age` (bestaat: `BlockStates`/`metaMask`); sapling-boomgenerator hergebruiken uit `TerrainGenerator.placeTree`; farmland-blok + schoffel; nieuwe blokken/textures. **L** (ticker S, daarna per plant S–M).

### 3.4 Vuur

Vuur heeft `age 0–15`, geplande tick elke 30–40 ticks; verspreidt naar brandbare buren (ignite-odds: hout/planken 5, leaves/wol 30..., burn-odds per blok) afhankelijk van difficulty en leeftijd; dooft bij water, regen (kans 20% + 3% per age) of op niet-brandbaar zonder bron; netherrack/soul sand brandt eeuwig. Entiteit in vuur: 1 HP per tick met invulnerability (dus ~1 HP per 10 ticks effectief; de wiki zegt 1 HP/s buiten vuur); soul fire dubbel. Aansteken: flint & steel, fire charge, lava (random tick), bliksem, TNT.

**Status:** Gedeeltelijk: spelers/mobs kunnen branden (lava, zombie in de zon), flint & steel steekt TNT aan; er is geen vuurblok en geen verspreiding. **Nodig:** `FIRE`-blok (zonder collision, lichtniveau 15, animatie), tick-logica, brandbaarheidstabel per blok. **M.**

### 3.5 Redstone (minimaal, voor wie het wil)

| Component | Regel |
|---|---|
| Signaal | 0–15; dust verliest 1 per blok; sterkte bepaalt comparatoruitvoer |
| Bronnen | lever (aan/uit), knop (steen 20 ticks, hout 30), drukplaat (hout: alle entities, steen: mobs/spelers; gewogen), redstone torch (inverteert, 1 tick vertraging, burnout na > 8 toggles in 60 ticks, onzeker), observer, daylight sensor, tripwire |
| Doorgeven | sterk vs. zwak aangedreven blok, dust-richtingen, "quasi-connectivity" (alleen Java: pistons/deuren voelen ook powered via blok erboven) |
| Repeater | 1–4 redstone ticks (2 game ticks elk), versterkt; comparator vergelijkt/trekt af |
| Piston | duwt ≤ 12 blokken; sticky trekt 1; 2 game ticks voor extend/retract (0–1 tick startvertraging in Java); obsidiaan, bedrock, block entities (kisten, ovens) en deuren kunnen niet; bloemen, fakkels, borden breken; slime/honing plakken |
| Observer | puls van 2 ticks als het blok voor het gezicht verandert |
| Deuren/trapdoors/hekken | open bij power of rechtsklik; ijzeren deur alleen met redstone |
| Hopper/dropper/dispenser | item-transport 8 ticks per item (onzeker), dispenser vuurt projectielen/legt blokken |

**Status:** Ontbreekt, op de eikenhouten deur na (handmatig openen; geen power).
**Nodig:** `RedstoneSim` (graaf met scheduled ticks, power-stuurwaarde in `meta`, update-volgorde), componenten als blokken met states; piston-systeem met blokverplaatsing in `World` + gelijktijdige edits op netwerk. **XL** voor dust+torch+repeater+lamp+piston; **M** voor alleen lever/knop/plaat die een deur of lamp aansturen (aanbevolen eerste stap).

### 3.6 Deuren, luiken, knoppen, hendels, drukplaten

Lever/knop/plaat: zie hierboven. Trapdoor: 3 px dik, open/dicht, boven/onder; hek en fence gate; ladder (klimt op kijkrichting, blok achter nodig; `wall-attachment` meta). Alle zijn blok-states die dezelfde machinerie als deur/slab gebruiken (`partial` shapes).

**Status:** Gedeeltelijk (alleen eikendeur). **Nodig:** shapes in `BlockShapes.ts`, `metaMask` per blok, interactie in `Interaction.ts`. **S–M per blok.** Ladders en hekken zijn de hoogste speelwaarde.

**Bronnen §3:** minecraft.wiki/w/Breaking, /Fortune, /Tree, /Farmland, /Wheat_Seeds, /Sugar_Cane, /Bone_Meal, /Fire, /Redstone_circuits, /Piston, /Composter, /Tick, /Tools.

---

## 4. Crafting en items

### 4.1 Crafting

Vanilla: 2×2 (inventory) of 3×3 (werkbank) rooster met vorm-recepten (shaped, spiegelbaar) en vormloze recepten, plus receptenboek met auto-invullen. **BunkCraft kiest een receptenlijst zonder rooster** ("recipe-book crafting, stations within 4 blocks"): dat is een bewuste afwijking. Uitbreiding van het aantal recepten (~36 nu) volgt de lijst van items; rooster-crafting pas als creatieve vrijheid (zelf patronen) nodig is. **Status: Gedeeltelijk (aanwezig als receptenlijst).** Nodig voor rooster: UI + shaped matcher, **M–L**; geen prioriteit.

### 4.2 Oven, hoogoven, rokerij

| Regel | Waarde |
|---|---|
| Kooktijd | oven 200 ticks (10 s) per item; blast furnace en smoker 100 ticks (blast: alleen ertsen/metaal, smoker: alleen eten); campfire 600 ticks per item (4 items) |
| Brandstof (ticks → items) | lava bucket 20 000 (100 items), coal block 16 000 (80), dried kelp block 4 000 (20), blaze rod 2 400 (12), coal/charcoal 1 600 (8), logs/planks 300 (1,5), houten gereedschap 200, bamboo 50, stick 100, sapling 100, wol 100, boot 1 200 |
| XP | wordt bewaard in de oven en uitgereikt bij het pakken van de output |
| Sloten | input, brandstof, output; stopt bij leeg/vol; dooft zonder brandstof (progress zakt 2×/tick) |

**Status:** Gedeeltelijk: oven is crafting-station met "vuur"-recepten (glas, steen, ijzer, houtskool, vlees) en brandstofverbruik wordt gesimuleerd; geen ovenblok-UI met tijd, geen blast furnace/smoker, geen XP, oven heeft geen richting of brandende staat.
**Nodig:** `FurnaceBlockEntity` (3 slots, burnTime, cookTime, 20 Hz tick, server-authoritatief, save via chunk-entity-store), richting en lit-state in `meta`, GUI. Requires een **block entity** subsysteem (ook voor kisten): **L** om één keer te bouwen, daarna **S** per container.

### 4.3 Anvil, grindstone, smithing, stonecutter

| Station | Regel |
|---|---|
| Anvil | combineren: sacrifice-durability + 12% bonus (kost 2 levels); materiaal repareert 25% per stuk (1 level); hernoemen 1 level; kosten = som van base-cost + enchantkosten + 2^n−1 prior work penalty; "Too Expensive!" bij ≥ 40 levels (Survival); elke gebruik 12% kans dat anvil een stap slijt (anvil → chipped → damaged → weg) |
| Grindstone | verwijdert alle niet-vloek-enchants, geeft XP terug, combineert twee items |
| Smithing table | template + diamond-item + netherite-ingot → netherite-item; trim-templates voor harnas (cosmetisch) |
| Stonecutter | 1:1 stenen/slabs/stairs-recepten, goedkoper dan craften |

**Status:** Ontbreekt. **Nodig:** `ItemStack` met `enchants`/`repairCost`/`name` (zie §2), station-UI, XP (§1.3). **M** per station na enchants (anvil **L**).

### 4.4 Enchanting table

15 boekenkasten op ring-posities (2 blokken afstand met 1 gat; max 15 telt). `base = rand(1,8) + floor(b/2) + rand(0,b)`; slot 1 `max(base/3,1)`, slot 2 `base·2/3+1`, slot 3 `max(base, 2b)`; je betaalt 1/2/3 levels én 1/2/3 lapis; resulterende enchants worden random gekozen uit een gewogen lijst (kans per level en materiaal enchantability: hout 15, steen 5, ijzer 14, goud 22, diamant 10, leer 15, netherite 15: onzeker). Enchant seed per speler zodat opties stabiel blijven.

**Status:** Ontbreekt (boekenkast als blok bestaat). **Nodig:** XP (§1.3), `enchants` op stacks (§2.5), lapis (erts + tinten), UI, gewichtentabellen, "Standaard Galactic"-lettertype niet nodig. **L** (na enchant-data).

### 4.5 Brewing

Brewing stand: blaze powder als brandstof (20 charges); 400 ticks (20 s) per batch van 3 flessen. Basis: water bottle + nether wart → awkward; awkward + ingrediënt → potion (Speed: suiker, Fire Resistance: magma cream, Healing: glistering melon, Strength: blaze powder, Regeneration: ghast tear, Night Vision: gouden wortel, Water Breathing: pufferfish, Poison: spinnenoog, Leaping: konijnenvoet, Slow Falling: phantom membrane...). Redstone verlengt (3:00 → 8:00), glowstone verhoogt level (korter), gunpowder → splash, dragon's breath → lingering (¼ duur), fermented spider eye keert om. Vereist Nether-items (nether wart, blaze rod, ghast tear, magma cream) → hangt aan Nether.

**Status:** Ontbreekt. **Nodig:** effectsysteem (§2.5), block entity (§4.2), Nether-grondstoffen of een vereenvoudigde bron (bijv. nether wart in woestijn-tempels als overgangsoplossing, ontwerpkeuze). **L**.

### 4.6 Handelen met villagers

| Regel | Waarde |
|---|---|
| Levels | Novice 0 XP, Apprentice 10, Journeyman 70, Expert 150, Master 250 |
| Beroepen en job-site-blok | armorer (blast furnace), butcher (smoker), cartographer (cartography table), cleric (brewing stand), farmer (composter), fisherman (barrel), fletcher (fletching table), leatherworker (cauldron), librarian (lectern), mason (stonecutter), shepherd (loom), toolsmith (smithing table), weaponsmith (grindstone); plus nitwit en unemployed (13 beroepen) |
| Restock | 2× per dag mits ze werken (Java: job site nodig) |
| Prijs | basisprijs + demand-bijdrage (stijgt per gebruik, daalt per dag) + gossip/reputatie; Hero of the Village −30% −6,25% per level; prijs ≥ 1, ≤ stackgrootte; exacte formule onzeker |
| Max uses | begrensd per trade, rode X als op |
| Voorbeelden | farmer: 20 tarwe → 1 emerald, 1 emerald → 6 brood; librarian: enchanted book 5–64 emeralds afhankelijk van level (onzeker) |
| Wandering trader | verschijnt random in de buurt van de speler, 2 lamas |

**Status:** Ontbreekt (geen villagers, geen emeralds, geen dorpen). **Nodig:** villager-entity met schedule (§5.4), job-site-blokken, trade-UI, trade-tabellen als data, emerald-erts + drop. **L–XL** (hangt af van dorpen §6.3).

### 4.7 Loot tables, kisten

Loot table = JSON met pools; elke pool heeft `rolls` (vast of range), `bonus_rolls`, entries met `weight`, conditions (`killed_by_player`, `random_chance`, `table_bonus` voor Fortune/Looting) en functions (`set_count`, `looting_enchant` (+1 max per Looting level), `furnace_smelt`, `enchant_randomly`). Mob-drops en kist-loot en blok-drops delen dit formaat; loot beïnvloedt geen XP.
Voorbeeld mobdrops: zombie 0–2 rot vlees, +zeldzaam wortel/aardappel/ijzer; skeleton 0–2 bones, 0–2 arrows; creeper 0–2 gunpowder; spin 0–2 string, 0–1 spinnenoog; enderman 0–1 pearl; witch redstone 4–8 + diverse; slime 0–2 slimeball; pig 1–3, cow 1–3 + 0–2 leer, sheep 1 wol + 1–2 mutton, chicken 1 + 0–2 veer.

**Status:** Ontbreekt als systeem: drops staan hard-gecodeerd in `MobTypes.ts` (`stack(id,count)`), geen kist-blok, geen kist-loot (kisten staan op de ROADMAP als "M: nodig voor alle structuren").
**Nodig:** `LootTable` TypeScript-data (geen JSON nodig), `rollLoot(table, ctx)`, kist als block entity (§4.2), 2-slot "dubbele kist". **M** voor loot, **L** voor block-entity-kist met UI en netwerk.

### 4.8 Vissen

Bijt-wachttijd 100–600 ticks (5–30 s), −100 ticks (−5 s) per Lure-level; vangst: vis 85%, junk 10%, schat 5% (Luck of the Sea schuift richting schat: onzeker voor getallen); schat vereist open water (5×4×5 rond de dobber); XP 1–6; kost 1 durability. Vissen: kabeljauw, zalm, kogelvis, tropische vis. Junk: stok, bot, leer, waterfles, enz.; schat: boek, zadel, naamplaatje, nautilusschelp.

**Status:** Ontbreekt. **Nodig:** hengel + dobber-entity, water-detectie, loot (§4.7), minigame-timing. **M.**

**Bronnen §4:** minecraft.wiki/w/Smelting, /Anvil_mechanics, /Brewing, /Trading, /Villager, /Fishing, /Loot_table, /Composter, /Enchanting, /Tools.

---

## 5. Mobs

### 5.1 Overworld-lijst

Gezondheid in HP (2 HP = 1 hart). Schade = Normal; Easy `min(D, D/2+1)`, Hard `1,5·D`. "Status": Aanwezig = in `MobTypes.ts`.

| Mob | HP | Schade | Gedrag / AI | Drops | Status |
|---|---|---|---|---|---|
| Varken | 10 | 0 | wandelt, panic; zadel; wordt zombified piglin bij bliksem | 1–3 rauw varken | Aanwezig |
| Koe | 10 | 0 | panic; melk met emmer | 1–3 rundvlees, 0–2 leer | Aanwezig (leer ontbreekt) |
| Schaap | 8 | 0 | eet gras (herstelt wol), scheren, verven | 1 wol, 1–2 mutton | Aanwezig |
| Kip | 4 | 0 | geen valschade; ei elke 5–10 min | 1 kip, 0–2 veer | Aanwezig |
| Konijn | 3 | 0 | springt snel; vluchtend; 8 kleurvarianten | 0–1 hide, 0–1 foot (10%) | Ontbreekt |
| Paard / ezel / muildier | 15–30 | 0 | temmen (temper 0–99, +5 per mislukte poging), zadel, armor; spawn plains/savanna in 2–6; speed 4,86–14,57 b/s; jump 1,15–5,92 | leer | Ontbreekt |
| Wolf | 8 wild / 40 tam | 4 | neutraal tot aangevallen; bot 1/3 kans taming; zit/volgt; valt skeletons/schapen aan; armor met armadillo scute | niets | Ontbreekt |
| Kat / ocelot | 10 | 0 | vis 1/3 taming; verjaagt creepers/phantoms (6/16 blokken); cadeaus | niets | Ontbreekt |
| Vos, bij, schildpad, lama, panda, geit, kameel, armadillo, kikker, axolotl, papegaai, dolfijn, squid, vissen | 3–32 | 0–2 | biome-specifiek | divers | Ontbreekt |
| Villager | 20 | 0 | schema, bedden, beroepen (§4.6) | niets | Ontbreekt |
| Iron golem | 100 | 7–21 (onzeker) | verdedigt dorp, 100% KB-weerstand, 25 HP per ijzerstaaf; spelergebouwd (T van 4 ijzerblokken + pompoen) | 3–5 ijzer, 0–2 poppy | Ontbreekt |
| Zombie | 20 | 2,5/3/4,5 | volg 35 blokken; brandt in zon (tenzij helm/water); 5% baby (sneller 0,35); op Hard breekt deuren, versterking; woningkans voor zombie villager; 30 s onder water → drowned; pakt wapens op | 0–2 rot vlees; zeldzaam wortel/aardappel/ijzer | Aanwezig |
| Husk | 20 | idem + Hunger | woestijn, brandt niet | rot vlees | Ontbreekt |
| Drowned | 20 | 2,5–4,5 (6,25% trident 5–12 b) | zwemmen, 's nachts naar de kust; 3% nautilusschelp (Java); niet brandend overdag | rot vlees, gouden staaf, koper, trident | Ontbreekt |
| Skeleton | 20 | pijl 2–4 / 3–5 / 4–8 | range 15, schiet elke 3 s (Hard 2 s); strafet; vlucht van wolf; brandt in zon | 0–2 bones, 0–2 arrows | Aanwezig (strafe? onzeker) |
| Stray / Bogged | 20 / 16 | pijl + Slowness / Poison | sneeuwgebied / moeras | | Ontbreekt |
| Creeper | 20 | explosie 3 (geladen 6) | detectie 16 (8 sneak); fuse 30 ticks; start < 3 blokken met zicht; stopt > 7 of zonder zicht; bliksem ≤ 4 blokken laadt; kat schrikt | 0–2 gunpowder; plaat als skeleton-kill | Aanwezig |
| Spin | 16 | 2 (Hard 3,5) | klimt; neutraal bij licht ≥ 12; rijd skeleton 1% | 0–2 string, 0–1 spinnenoog | Aanwezig |
| Cave spider | 12 | poison 7 s (N) / 15 s (H) | mijnschacht-spawner | string, spinnenoog | Ontbreekt |
| Enderman | 40 | 7 (4,5/7/10,5: onzeker) | neutraal; boos bij 5 ticks oogcontact binnen 64 blokken; teleporteert bij schade/water/ projectielen (≤ 32 blokken); stopt bij pompoen; 1 HP schade door water/regen; pakt blokken (Java-lijst); 2,9 hoog | 0–1 ender pearl | Ontbreekt |
| Witch | 26 | gooit splash (poison, slowness, weakness, harming ≤ 6) | drinkt healing/fire res/water breathing/speed; magie −85%; swamp huts; bliksem op villager | 4–8 redstone + diverse | Ontbreekt |
| Slime | 16/4/1 | 3/2/0 | grootte 4/2/1, splitst in 2–4 kleinere; springt elke 10–30 ticks; slime chunks (1/10 chunks) onder y < 40 en moeras y 51–69 (maan) | 0–2 slimeball (alleen klein) | Ontbreekt |
| Phantom | 20 | ~6 (Normal, onzeker) | 72 000 ticks niet geslapen → 's nachts; duikt; brandt in zon; kat schrikt | phantom membrane | Ontbreekt |
| Silverfish | 8 | 1 | infested blokken | | Ontbreekt |
| Pillager | 24 | kruisboog 3,5–5 (N) | patrouilles, outpost, raid | kruisboog 8,5% | Ontbreekt |
| Vindicator | 24 | 13 (N) | bijl, mansion/raid | smaragd, bijl | Ontbreekt |
| Evoker, vex, ravager | 24 / 14 / 100 | fangs / 9 / 12 | raid, mansion | totem (evoker) | Ontbreekt |
| Guardian / elder | 30 / 80 | laser | oceaanmonument | prismarine | Ontbreekt |
| Warden | 500 | 30 (N) | deep dark, sonic boom, trillingen | | Ontbreekt (niet haalbaar zonder diepe wereld) |
| Breeze / creaking | 30 / ? | wind charge / ? | trial chamber / Pale Garden | | Ontbreekt (laag) |

Bron voor HP/schade: wiki-pagina's per mob (hierboven opgehaald); waar "onzeker" staat heb ik de waarde niet kunnen bevestigen.

### 5.2 Spawnregels

| Regel | Waarde |
|---|---|
| Spawncyclus | elke tick voor monsters; dieren elke 400 ticks (alleen als de chunk dieren-cap niet vol is, onzeker); extra spawns bij wereldgeneratie voor dieren (~10% van chunks) |
| Bereik | chunks met een speler binnen 128 blokken horizontaal; spawn binnen 128-bol rond speler; niet binnen 24 blokken; vis 64 |
| Caps | monster 70, creature 10, ambient (bat) 15, water creature 5, water ambient 20, onderwater-creature 5 (axolotl); globaal `cap · chunks/289`, begrensd per speler |
| Licht (hostile overworld) | block light 0 én sky light ≤ willekeurig 0–7 (`monster_spawn_light_level` uniform 0–7); dieren: lichtniveau ≥ 9 op gras |
| Blokken | vol bovenvlak; hostile niet op `bedrock`/barrier; dieren op gras; vissen in water; bats in grotten (licht ≤ 4) |
| Packs | pogingen max 4 (8 wolves/cod/tropical, 6 paarden/ezels) |
| Despawn | instant > 128 blokken; random > 32 blokken kans 1/800 per tick; niet binnen 32 blokken; geen despawn bij name tag / persistent / dieren (Java) |
| Peaceful | alle hostile spawns uit |
| Moeilijkheid | difficulty en regional difficulty scalen armor/wapens en speciale eigenschappen (zombie-pickup, versterking) |

**Status:** Gedeeltelijk. Aanwezig (`EntityManager.ts`): caps (24 passief, 16 hostile (+12 per extra speler), tot 48), spawn 24–48 blokken bij donker (block light 0 + gedimde sky), despawn 128/32 met 1/800, dieren bij chunk-generatie (12% per chunk). Verschillen: caps veel lager dan vanilla (bewuste performance-keuze), spawn-afstand 24–48 i.p.v. 24–128, geen cave-spawn-lichtregels per biome, geen packs behalve dieren.

### 5.3 Fokken en baby's

Voeding laat dier 600 ticks (30 s) in "love mode"; twee dieren lopen naar elkaar, krijgen na ~2,5 s een baby (XP 1–7); cooldown 6000 ticks (5 min); baby groeit 24 000 ticks (20 min), voeren −10% rest. Voedsel: koe/schaap/mooshroom tarwe; varken wortel/aardappel/bietwortel; kip zaden; wolf vlees; paard gouden appel/wortel; kat vis; schildpad zeegras (eieren). Villagers: 3 bedden en voedsel (brood 3 / wortels 12), geen directe voeding. Baby's zijn kleiner (hitbox ×0,5), een zombie-baby is sneller (0,35) en kan op een kip rijden.

**Status:** Ontbreekt. **Nodig:** `Mob.age`, `loveTicks`, `breedCooldown`, `follow-food` goal, `breed` goal, schaal in `MobRenderer` (instanced per bodypart: schaalfactor per instance), tarwe-item. **M**; afhankelijk van gewassen voor voedsel (§3.3).

### 5.4 Speciale gedragingen

- **Creeper:** fuse 30 ticks, wordt geladen door bliksem; blast "swell" door val: `fallDistance·1,5`.
- **Skeleton:** strafet rond de speler binnen bereik, schiet elke 3 s (Hard 2 s); vlucht van wolven; brandt in daglicht.
- **Enderman:** zie tabel; teleporteert in regen, 3×3 ontwijkt projectiel.
- **Slime:** splitsen, 2–4 kleintjes per dood.
- **Phantom:** insomnia (§1.4), kat verjaagt (16 blokken).
- **Drowned:** zombie → drowned na 30 s met hoofd onder water (+15 s conversie).
- **Villager-schema (ticks van de dag):** werken 2000–9000, verzamelen 9000–11000, slapen vanaf 12000; panic bij zombies; iron golem-spawn als 3 villagers in paniek of 5 praten (onzeker); raids: Bad Omen → Raid Omen op dorp, 30 s wachttijd, golven.
- **Wolf:** 1/3 taming met bot per poging; zit/volgt; teleport naar eigenaar; 40 HP tam.
- **Bij:** 10 HP, pollineren gewassen (versnelt groei), honey bij 5 niveau, campfire-rook voorkomt agressie, dood na steken.
- **Cats:** 1/3 taming met vis, scare creepers.
- **Paarden:** temper, zadel, springhoogte.
- **Hostile difficulty scaling:** schade ×(0,5·D+1 tot 1,5), op Hard versterking van zombies, deurbreken, grotere kansen op uitrusting via regional difficulty.

**Nodig per mob (M elk):** `MobTypes`-entry + model + AI-goals (BunkCraft kent goals zoals Minecraft); nieuwe goals: strafe (aanwezig?), teleport, throw-potion, swarm, follow-owner, sit. **Eerste keuze uit speelwaarde/moeite:** konijn (S), wolf + taming (M), enderman (M), witch (M), slime (M, nodig voor cave-vulling), drowned (M, nodig voor oceaan), husk (S), cave spider (S).

**Bronnen §5:** minecraft.wiki/w/Mob, /Mob_spawning, /Zombie, /Skeleton, /Creeper, /Enderman, /Witch, /Slime, /Drowned, /Phantom, /Wolf, /Cat, /Horse, /Bee, /Villager, /Iron_Golem, /Breeding, /Spider, /Pillager, /Passive_mob.

---

## 6. Wereld

### 6.1 Biomes en klimaat

Vanilla (1.18+ multi-noise, met zes parameters): `temperature`, `humidity (vegetation)`, `continentalness`, `erosion`, `weirdness (ridges)`, `depth` (hoogte, 0 aan het oppervlak, 1 diep). Biome = dichtstbijzijnde parameterpunt. Neerslag volgt biome-temperatuur: `> 0,15` regen, `< 0,15` sneeuw, "geen" in woestijn/savanne/badlands.

| Categorie | Biomes (temp.) |
|---|---|
| Oceaan | Ocean 0,5 (wiki-lijst noemt 0,1: onzeker), Deep, Cold (0,0), Frozen (−1,0, sneeuw), Lukewarm/Warm (0,5), Mushroom Fields (0,9) |
| Vlakten | Plains 0,8, Sunflower Plains, Snowy Plains 0,0 (sneeuw), Ice Spikes |
| Bos | Forest 0,7, Flower Forest, Birch (0,6), Old Growth Birch, Dark Forest, Taiga 0,25, Snowy Taiga −0,5, Old Growth Pine/Spruce Taiga, Jungle 0,95, Sparse Jungle, Bamboo Jungle, Pale Garden |
| Droog | Desert 2,0 (geen neerslag), Savanna 1,2, Savanna Plateau, Windswept Savanna, Badlands, Wooded/Eroded Badlands (2,0) |
| Water-rand | River 0,5, Frozen River, Beach 0,8, Snowy Beach, Stony Shore, Swamp 0,8, Mangrove Swamp |
| Hoog | Meadow, Cherry Grove, Grove, Snowy Slopes, Windswept Hills, Gravelly, Jagged/Frozen/Stony Peaks |
| Grot | Lush Caves, Dripstone Caves, Deep Dark (+ Sulfur/Ice Caves, onzeker) |


**Status:** Gedeeltelijk: 8 biomes (`Biomes.ts`: Ocean, Beach, Plains, Forest, Desert, Taiga, Snowy Plains, Mountains) uit 2D-functies van `TerrainGenerator.biomeAt` (hoogte + ruis). Geen rivieren, moeras, savanne, jungle, badlands, mushroom, aparte grot-biomes. Biome-tint bestaat (`BiomeColors`).
**Nodig:** biomeparameters (temp/humidity/continentalness-ruis) ter vervanging van de vaste regels, **M**; nieuwe biomes **M per stuk** (surface, planten, bomen, mobs, kleuren); rivieren **M**; vegetatie-tabellen per biome **S**.

### 6.2 Terreingeneratie 1.18+ (schets) en wat realistisch is voor 128 hoog

Vanilla: 3D dichtheidsfunctie `initial_density = f(continentalness, erosion, peaks&valleys, depth)` via splines; hoogte −64..320; aquifers (grondwater/lava onder y −54); grotten: *cheese* (grote kamers), *spaghetti* (tunnels), *noodle* (dun), carvers (klassieke grotten, ravijnen); ertsaders; features (bomen, planten, ertsen, meren) per generatiestap. Spawn: zoekt een droog stuk dichtbij (0,0).

**Ertsen (vanilla, y-range / piek / aanbeveling voor 128 hoog; getallen onzeker waar gemarkeerd):**

| Erts | Vanilla | Voorstel BunkCraft (128 hoog) |
|---|---|---|
| Kolen | 0–320, piek 95 | y 1–110, piek 80, groot |
| IJzer | −64–72, piek 14/232 | y 1–64, piek 16 |
| Koper | −16–112, piek 43 | y 1–60, piek 40 |
| Goud | −64–32 (+ badlands 32–256) | y 1–32, piek 10 |
| Redstone | −64–16, piek −59 | y 1–15 |
| Lapis | −64–64, piek 0 | y 1–30, piek 14 |
| Diamant | −64–16 (piek −59) | y 1–16 (triangulair, 3× per chunk bij klein) |
| Emerald | berg, −16–320 | berg y 4–100, 1 stuk |

(De waarden voor BunkCraft zijn een ontwerpvoorstel en geen vanilla.)

**Status:** Gedeeltelijk: heightmap + 3D-simplexgrotten (`CAVE_STEP 4`, drie velden), kolen/ijzer/goud/diamant, lava-meren onder y 11, bomen/cactus/planten per biome; ontbreken: aquifers, ravijnen, koper/redstone/lapis/emerald, geodes, sneeuwlaag, strand-variatie, rivieren. De grotgeneratie wordt nu door een andere ontwikkelaar uitgebreid: hier niet aanraken.

### 6.3 Structuren

| Structuur | Schets vanilla | Haalbaar in 128 hoog | Effort |
|---|---|---|---|
| Dungeon (monster room) | 3×3–7×7 kamer met spawner (zombie/skeleton/spin) en 1–2 kisten, y onder maaiveld | ja, ideaal eerste structuur | M (spawner-blok, kist, loot) |
| Mijnschacht | gangen met houten steunen, rails, cave-spider-spawner, kisten | ja | L |
| Dorp | huizen, wegen, farm, smid, kerk, villagers (§4.6), iron golem, bedden, bel; varieert per biome | ja (op vlakken) | XL |
| Woestijntempel / jungletempel | piramide met pressure-plate trap en 4 kisten | ja | M per stuk |
| Igloo, ruined portal, shipwreck, buried treasure, ocean ruins, swamp hut (witches) | kleine voorgebouwde stukken | ja | S–M per stuk (blokplaatsing + loot) |
| Pillager outpost | toren + patrouilles | later | M |
| Stronghold | portal naar End, ~128 per wereld rond oorsprong | alleen als End er is | L |
| Woodland mansion | enorm, dark oak, vindicators | nee (te groot, 3 verdiepingen) | XL, overslaan |
| Ocean monument | prismarine + elder guardians | nee | XL, overslaan |
| Ancient city (y −51) / trial chambers | diep onder y −10, deepslate | nee zonder −64 | overslaan |
| Fossielen, geodes | decoratie | ja | S |

**Nodig voor structuren:** structure-system (`StructureStart` met bounding box en pieces, deterministisch uit seed, over chunk-grenzen heen schrijven; ook in server `ServerWorld`), loot (§4.7), spawner-blok, kist. **L** voor het systeem, dan **S–M** per structuur.

### 6.4 Weer

| Regel | Waarde |
|---|---|
| Cyclus | twee vlaggen: regen aan 12 000–24 000 ticks (10–20 min), uit 12 000–180 000 ticks (10 min–2,5 u); onweer aan 3 000–15 600 ticks (3–13 min: de wiki zegt 3–13 min), alleen met regen |
| Neerslag-soort | biome-temperatuur `> 0,15` regen; `< 0,15` sneeuw; geen in droog |
| Effecten | regen blust vuur (20%+3%/leeftijd), hydrateert farmland, vult cauldron; zet sky light op 12 (voor spawn-regels); sneeuw laat sneeuwlagen groeien (tot 8, snow layer 1/8 per laag) en freezet water in koude biomes (random tick, block light < 10) en ijs smelt bij block light > 11 |
| Bliksem | tijdens onweer random per chunk (kans 1/100 000 per tick, onzeker); 5 HP + brand; creeper → geladen, varken → zombified piglin, villager → witch, "Channeling" trident; lightning rod trekt aan |
| Slapen | beddenregels (§1.4) tijdens onweer: slapen toegestaan; na slapen wordt het weer helder |

**Status:** Ontbreekt (alleen dagcyclus, `DayCycle.ts`, `DAY_LENGTH = 1200 s` = 24 000 ticks). **Nodig:** `Weather`-state in `World`/server-tijd (broadcast in protocol), regen/sneeuw-deeltjes en shader (mist/sky-donkerder), geluid, farmland-hydratatie, random-tick koppeling; **M** (visueel + server), bliksem **S** daarna.

### 6.5 Dagcyclus en maan

24 000 ticks per dag (20 min). Tick 0 = 06:00; middag 6000; zonsondergang 12 000–13 000 (50 s); nacht 13 000–23 000, middernacht 18 000; zonsopgang 23 000–24 000. Hostile mobs spawnen ± 13 188 ticks per nacht (licht-afhankelijk). Maanfasen: 8 dagen = 192 000 ticks; vol-maan: sterkste regional difficulty, meer slimes in moeras, 4× kans op slime spawn; nieuwe maan zwakste. Mobs die in de zon branden: zombie, skeleton, phantom, stray niet.

**Status:** Gedeeltelijk: dagcyclus met 20 min, zonsondergang-gloed, mobs reageren op duisternis; maanfasen en maanfase-effecten ontbreken. **Nodig:** maanfase in `Sky.ts` (8 sprites/UV), regional-difficulty-input. **S.**

### 6.6 Licht

Niveaus 0–15; twee soorten: *block light* (bron − 1 per stap, flood fill) en *sky light* (15 aan open lucht, niet verlaagd 's nachts: dagnacht verandert alleen de weergave en de spawn-logica); `max(block, sky)` voor weergave; water verzwakt sky light maar niet block light; leaves/water extra verzwakking (BunkCraft: `lightFilter`).

Lichtbronnen: fakkel 14, glowstone 15, lava 15, lantaarn 15, vuur 15, redstone lamp 15 (aan), end rod 14, campfire 15, kaars 3–12 (onzeker), jack-o'-lantern 15, magma 3, sculk sensor 1.
Drempels: monster-spawn block light 0, sky ≤ 7 (willekeurig); dieren-spawn ≥ 9; gewassen groeien ≥ 9 (planten ontwortelen bij licht ≤ 7 in Java); slapen sky light ≤ 11.

**Status:** Aanwezig (BFS in `Lighting.ts` over 48×48×130, smooth light in mesher, torch 14, lava 15, glowstone). **Nodig:** alleen consumers (spawn/plant); lichtbronnen-uitbreiding bij nieuwe blokken. **S.**

### 6.7 Water, lava, ijs

Water: verspreidt 7 blokken, 1 blok per 5 ticks; oneindig valt; nieuwe bron als horizontaal naast ≥ 2 bronnen en op een vast blok/bron; lava (overworld): 3 blokken, per 30 ticks (Nether 7 per 10); lava-bron + water = obsidiaan; stromend + stromend = cobblestone; lava stroomt op water = steen (stone); concrete powder hardt. IJs en sneeuw: koude biomes bevriezen water bij random tick; ijs smelt bij block light > 11; sneeuwlaag-accumulatie bij sneeuw (tot 8 lagen of 1 per random tick, onzeker).

**Status:** Aanwezig (`Liquids.ts`: water 7/5 ticks, lava 3/30, oneindige bron, obsidiaan/cobble, vallend water, emmers; budget 600 updates/tick) voor waterstromen. Ontbreekt: ijs, sneeuwlagen, stroming die entities meeduwt, waterlogged slabs, concrete. **Nodig:** ijs/sneeuw hangt aan weer + random ticks. **M.**

### 6.8 Dimensies

**Nether:** 128 hoog (zelfde als BunkCraft!), bedrock plafond y 123–127, lava-zee y ≤ 31; coördinaten 8:1; portaal: obsidiaan-frame min 4×5 (binnen 2×3), flint & steel, wachttijd ~4 s (80 ticks, onzeker) en cooldown; biomes: Nether Wastes, Crimson Forest, Warped Forest, Soul Sand Valley, Basalt Deltas; mobs: ghast, zombified piglin, piglin, hoglin, magma cube, blaze (fortress), wither skeleton, strider; structuren: fortress, bastion, ruined portal, fossil; geen water, bed explodeert (kracht 5). Ertsen: nether quartz 0–128 piek 114, nether gold 10–117, ancient debris 8–120 piek 16 (zeldzaam).
**Minimale Nether voor BunkCraft:** (1) tweede `World` met eigen `TerrainGenerator` (netherrack met 3D-ruis, lavazee, soul sand/gravel/glowstone/quartz); (2) dimensie-veld in chunk-key/protocol/save/IndexedDB; (3) portaalblok + detectie + teleport met 1:8 coördinaten en zoeken/bouwen van het tegenportaal; (4) mobs: zombified piglin, ghast (vuurbal), magma cube; (5) licht zonder sky light; geen weer/dagcyclus; (6) bed explodeert. **XL** (~3–4 weken).

**End:** portaal via stronghold (12 ogen), main island (obsidiaan-pilaren met kristallen), Ender Dragon (200 HP, phases), exit portal + eindcredits, outer islands/End cities/shulkers/elytra later; endermen. **Minimale End:** één eiland, 10 pilaren, vereenvoudigde draak (zweeft, valt aan, kristallen), credit-scherm. **XL.** Past bij ROADMAP "Eindspel (L)".

**Status:** Ontbreekt. **Bronnen §6:** minecraft.wiki/w/Biome, /World_generation, /Ore, /Structure, /Weather, /Daylight_cycle, /Light, /Water, /Nether, /The_End.

---

## 7. Technisch

| Onderwerp | Vanilla | BunkCraft |
|---|---|---|
| Tick | 20 TPS (50 ms); fases: wereldtijd, weer, blok-ticks (geplande), random ticks, entities | 20 Hz game tick + vaste 60 Hz physics (`Game.ts`) |
| Random tick speed | 3 per 16³-sectie per tick (`random_tick_speed`) | Ontbreekt |
| Scheduled ticks | blokken plannen een tick (water 5, lava 30, repeater, vuur 30–40, gravity 2) | Aanwezig voor vloeistoffen (`LiquidSim`, `World.tickLiquids`); generaliseren naar alle blokken |
| Simulatieafstand | standaard 10 chunks: alleen daar entities/blokken tikken; render distance los | Chunk-streaming op renderafstand; sim-afstand niet apart |
| Chunk-laden | tickets (entity-ticking niveau ≤ 31, block-ticking 32, border 33); spawnchunks weg sinds 1.21.9 | `ChunkManager` met prioriteit en upload-budget |
| Entity-limieten | maxEntityCramming 24 per blok; item despawn 6000 ticks (5 min), pickup delay 10 ticks (onzeker); XP-orb 5 min; pijl in blok 1200 ticks; passive spawn alleen binnen 240×240 rond speler | `MAX_ITEMS 160`, `MAX_ARROWS 128`, mob caps 24/16 |
| Performance | redstone en hoppers zijn de grootste tick-lasten | Doel 60+ FPS op iGPU zonder allocaties |

**Aanbevelingen voor een browserimplementatie:**
1. **Random ticks goedkoop maken:** `Uint8Array HAS_RANDOM_TICK[256]`; per tick per geladen chunk binnen simulatieafstand (4–6 chunks) 3 posities per sectie (128 hoog = 8 secties = 24 trekkingen/chunk); ≈ 6 900 trekkingen/tick bij 289 chunks is verwaarloosbaar. Gebruik een snelle RNG zonder allocatie, loop alleen chunks met bloktype-tellers > 0 (bijv. `Chunk.randomTickable` count) om gras/leaves niet te scannen.
2. **Geplande ticks:** één min-heap/bucket-queue op tick-nummer (zoals `LiquidSim`) met dedup per cel; budget per tick (nu 600 updates, 200 blokwijzigingen).
3. **Block entities** (kist, oven, spawner): `Map<chunkKey, Map<index, BlockEntity>>`, tikken alleen binnen simulatieafstand, serialiseren in chunk-record v3 (versie-migratie bestaat al).
4. **Server-authoritatief:** plantengroei, vloeistof, vuur, mobs en weer op de server (`ServerWorld`), clients optimistisch voor edits; random ticks nooit op de client in multiplayer.
5. **Meshing:** gewassen/cross-shapes en half-blokken zijn al `partial`/`cross`; groei-stadium via `meta` en één textuur-array-laag per stadium; remesh alleen de chunk bij een stadiumwisseling (batch per 20 ticks).
6. **Item/XP-orbs:** instanced billboards (bestaat voor drops), samenvoegen op afstand 0,5.
7. **Mobs:** InstancedMesh per lichaamsdeel (bestaat), nieuwe mobs hergebruiken dezelfde renderer-API; baby = schaal in instance-matrix.
8. **Budget AI:** pathfinding alleen elke N ticks, spreiding per mob-id; verre mobs op 1/4 snelheid.
9. **Opslag:** sparse edits (bestaat); nieuwe data (XP, spawnpunt, effects) in player-record, geen nieuwe databasestructuur.

**Bronnen §7:** minecraft.wiki/w/Tick, /Chunk, /Game_rule.

---

## 8. Prioriteitenlijst: de volgende 30 mechanics

Volgorde per speler-zichtbare waarde per effort; afhankelijkheden tussen haakjes. "Dev X" = werk dat anderen nu doen (content, mobs, grotten): niet dubbel doen.

### Fase 1 (early game loop: overleven, een basis bouwen, voedselcyclus)

| # | Mechanic | Effort | Afhankelijk van |
|---|---|---|---|
| 1 | **Random-tick systeem** (`RandomTicker`, sim-afstand, `HAS_RANDOM_TICK`) | S–M | geen (kern; server + singleplayer) |
| 2 | **Bomen: saplings, leaf decay, apple, stok** (boom-generator hergebruiken) | M | 1 |
| 3 | **Landbouw: schoffel, farmland, tarwe/zaden, brood, wortel/aardappel, bone meal** | M–L | 1; hydratatie-regel (water ≤ 4) |
| 4 | **Bed + spawnpunt + slapen/nacht overslaan** | M | block states (er), multiplayer-protocol |
| 5 | **Difficulty-instelling** (Peaceful/Easy/Normal/Hard) + schade-multiplier + game rules (`keep_inventory`, `random_tick_speed`, `spawn_mobs`) | S–M | menu, `WorldMeta`, protocol |
| 6 | **Armor** (4 slots, armor-bar, formule, leer van koe, ijzer/diamant/goud/koper-recepten) | L | inventory-slots, `PlayerStats.damage` |
| 7 | **Attack cooldown + melee-crit + sweep** | M | `attackSpeed` in items |
| 8 | **Kist + loot-tabellen** (block entity, dubbele kist, `rollLoot`) | L | block-entity-systeem |
| 9 | **Vallend zand/grind** (`FallingBlock`) | M | scheduled ticks |
| 10 | **XP-orbs + XP-balk + smelt-XP** | M | `PlayerStats`, entities |
| 11 | **Ladders, hekken, trapdoors, knoppen/hendels (zonder redstone)** | S–M per blok | block states |
| 12 | **Echte oven** (block entity, kooktijd 200, brandstof-tabel, richting/lit) | M–L | 8 (block entity) |

### Fase 2 (mid game: grotten/structuren, magie, vechten)

| # | Mechanic | Effort | Afhankelijk van |
|---|---|---|---|
| 13 | **Fokken + baby's** (love mode, cooldown, schaal) | M | 3 (voedsel), `Mob`-AI |
| 14 | **Weer** (regen/onweer, sneeuw, bliksem, farmland-hydratatie) | M | 1; server-sync |
| 15 | **Dungeons met spawner + kisten + loot** | M | 8 |
| 16 | **Mobs: enderman, witch, slime, drowned, husk, cave spider, wolf (taming), cat, paard** | M elk | Dev X (mobs), 5 (difficulty) |
| 17 | **Status-effecten-systeem** (Speed, Slowness, Strength, Regen, Poison, Fire Res, Water Breathing...) | L | 6 (damage-pijplijn) |
| 18 | **Schild + schild-disable** | M | 7, 6 |
| 19 | **Vuur-blok + verspreiding + brandbaarheid** | M | 1 |
| 20 | **Enchanting: item-data (`enchants` op `ItemStack`), tafel (boekenkasten, lapis), Efficiency/Sharpness/Protection/Unbreaking/Fortune/Silk Touch** | L–XL | 10 (XP), 8, protocol |
| 21 | **Anvil + grindstone** | L | 20 |
| 22 | **Mijnschachten + woestijn/jungle-tempels + kleine structuren** (structure-systeem) | L | 8, loot |
| 23 | **Vissen + hengel** | M | 8 (loot), water |
| 24 | **Suikerriet, cactus-groei, bamboo, kelp, paddenstoelen, pompoen/meloen** | S–M per plant | 1 |

### Fase 3 (late game, polish)

| # | Mechanic | Effort | Afhankelijk van |
|---|---|---|---|
| 25 | **Minimale redstone** (lever/knop/plaat + dust + torch + repeater + lamp; piston als laatste) | M → XL | block states, scheduled ticks |
| 26 | **Dorpen + villagers + handel** (schema, beroepen, job sites, emeralds, trade-UI; iron golem) | XL | 22, 4 (bedden), 17 |
| 27 | **Brewing + potions** (nether wart-vervanger of Nether) | L | 17, 20 |
| 28 | **Nether** (portaal, tweede wereld, ghast/piglin/magma cube) | XL | dimensie-concept in chunk/protocol/save |
| 29 | **Kruisboog, trident, mace, speer** + XP-Mending | M per wapen | 20 |
| 30 | **End + draak, raids, phantoms (insomnia)** | XL | 28, 4 |

**Opmerkelijke afhankelijkheden:** (a) *random ticks* (1) en *block entities* (8/12) zijn de twee fundamenten onder bijna alles; (b) *item-data op ItemStack* (20) raakt `Inventory`, `SaveSystem`, protocol, UI: begin vroeg met een schema-uitbreiding (`{id,count,data?}`) om een tweede migratie te vermijden; (c) *damage-pijplijn* (6, 17) moet één gecentraliseerd `applyDamage(source, amount, flags)` worden voor armor, effects, schilden en difficulty.

**Ontbrekende cijfers / onzeker, dus controleren vóór bouwen:**
- Exacte verdrinkings- en lavaschade-intervallen (code 2/s resp. 4 per 0,5 s; de wiki-samenvatting zei 2 per 10 ticks resp. 4/s).
- Sapling-groeilicht (8 of 9), farmland-groeipunten per buur, orb-waardentabel, bliksemkans per chunk.
- Mace/spear/crossbow schade, bijl-aanvalssnelheden per materiaal, harnas-durability, chainmail-punten.
- Trade-prijsformule, enchanting-gewichten, iron golem-schade (7–21 in de wiki-samenvatting), kans op boom-groottes.
- Alle Nether-portaaltimings.

---

## Bronnen (volledig)

- https://minecraft.wiki/w/Java_Edition_version_history
- https://minecraft.wiki/w/Hunger, /Food, /Damage, /Experience, /Game_rule, /Difficulty, /Bed, /Daylight_cycle, /Weather, /Light, /Tick, /Chunk
- https://minecraft.wiki/w/Combat, /Armor, /Enchanting, /Effect, /Shield, /Sword, /Bow, /Knockback_(mechanic), /Tools, /Breaking, /Fortune
- https://minecraft.wiki/w/Tree, /Farmland, /Wheat_Seeds, /Sugar_Cane, /Bone_Meal, /Fire, /Redstone_circuits, /Piston, /Composter
- https://minecraft.wiki/w/Smelting, /Anvil_mechanics, /Brewing, /Trading, /Fishing, /Loot_table
- https://minecraft.wiki/w/Mob, /Mob_spawning, /Creeper, /Skeleton, /Zombie, /Enderman, /Witch, /Slime, /Drowned, /Phantom, /Spider, /Wolf, /Cat, /Horse, /Bee, /Pillager, /Villager, /Iron_Golem, /Breeding, /Passive_mob
- https://minecraft.wiki/w/Biome, /World_generation, /Ore, /Structure, /Water, /Nether, /The_End

*Opmerking over de bronnen:* de wiki-pagina's zijn via een samenvattende fetch gelezen; getallen die ik uit geheugen aanvulde of die tussen samenvatting en eigen kennis afweken, zijn als "onzeker" gemarkeerd. De code-statussen zijn gecontroleerd op `feature/bunkcraft-engine` (commit a6c60cb).
