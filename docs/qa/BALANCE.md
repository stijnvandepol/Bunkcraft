# Balans-audit: BunkCraft tegen Minecraft Java 1.21

Audit van oktober 2026 op `feature/bunkcraft-engine` (na `b185ac0`). Elk gameplaygetal uit de code is vergeleken met Minecraft Java 1.21
(minecraft.wiki; waar `docs/research/MECHANICS.md` "onzeker" zei, is de wiki opnieuw opgehaald). De wereld is bewust 128 hoog en de
spawn-caps zijn bewust lager (zie `MobSpawner.ts`), dus geschaalde hoogtes en caps tellen als **bewust anders**.

**Verdicts:** **gelijk** · **bewust anders** (ontwerpkeuze of benadering, gedocumenteerd) · **fout → gefixt** (in deze audit, met
regressietest in `tests/balance.test.ts` of `tests/playerStats.test.ts`) · **fout → open** (gemeld, niet aangeraakt: valt onder de
combat-/schade-pijplijn die een andere ontwikkelaar herschrijft, of vraagt een nieuw systeem).

Bronnen (afgekort in de tabellen): **Attr** https://minecraft.wiki/w/Attribute · **Hun** https://minecraft.wiki/w/Hunger ·
**Dmg** https://minecraft.wiki/w/Damage · **Snk** https://minecraft.wiki/w/Sneaking · **Brk** https://minecraft.wiki/w/Breaking ·
**Exp** https://minecraft.wiki/w/Explosion · **Ske** https://minecraft.wiki/w/Skeleton · **Zom** https://minecraft.wiki/w/Zombie ·
**Arr** https://minecraft.wiki/w/Arrow · **Bow** https://minecraft.wiki/w/Bow · **Tool** https://minecraft.wiki/w/Tiers ·
**Arm** https://minecraft.wiki/w/Armor · **Food** https://minecraft.wiki/w/Food · **Spn** https://minecraft.wiki/w/Mob_spawning ·
**Day** https://minecraft.wiki/w/Daylight_cycle · **Wea** https://minecraft.wiki/w/Weather · **Smelt** https://minecraft.wiki/w/Smelting ·
**Stack** https://minecraft.wiki/w/Stack · **Mov** https://minecraft.wiki/w/Movement · **TNT** https://minecraft.wiki/w/TNT ·
**Cre** https://minecraft.wiki/w/Creeper · **Spi** https://minecraft.wiki/w/Spider · **Cow** https://minecraft.wiki/w/Cow ·
**DB** https://minecraft.wiki/w/Dead_Bush · **Bed** https://minecraft.wiki/w/Bed · **Void** https://minecraft.wiki/w/Void

## Samenvatting

| # | Gevonden | Was | Nu | Commit |
|---|---|---|---|---|
| 1 | Blokbereik in survival | 5 | 4,5 (creative 5) | `Use Minecraft's block reach` |
| 2 | Sneaken vertraagde niet | 4,317 b/s, sprinten kon | 1,295 b/s (0,3×), geen sprint | `Slow sneaking to 0.3x` |
| 3 | Regen-timer liep door op volle health | treffer → direct +1 HP | timer reset zoals `FoodData` | `Match Minecraft's regeneration timer` |
| 4 | Snelle regen bij saturatie < 6 | altijd 1 HP / 6 uitputting | `min(sat,6)/6` HP voor `min(sat,6)` | idem |
| 5 | HUD toonde fractionele health fout | 13,4 HP → laatste half hart leeg | `ceil(health)` zoals vanilla | idem |
| 6 | Bed stapelde tot 64 | 64 | 1 | `Stack beds to 1` |
| 7 | Koe liet geen leer vallen | 0 | 0–2 leer (leer-harnas en boeken nu haalbaar) | `Drop 0-2 leather from cows` |
| 8 | Follow range | zombie 32, spin 32 | zombie 35, rest 16 | `Use Minecraft follow ranges` |
| 9 | Skelet schoot elke 1 s (commentaar zei 2 s) | 20 ticks | 40 wachten + 20 spannen = 3 s | idem |
| 10 | Explosieschade aan mobs | `floor((1−d/2P)·7P)` (creeper-centrum 21) | `floor(7P(i²+i)+1)` (43), client + server | `Use Minecraft's explosion damage` |
| 11 | TNT-drops | 1/kracht (25%) | 100% (gamerule `tnt_explosion_drop_decay` uit sinds 1.21) | idem |
| 12 | Slijtage bij hakken | 1 per blok, ook fakkels/bloemen | 0 bij hardheid 0, zwaard 2, rest 1 | `Wear tools like Minecraft` |
| 13 | Dode struik | 50% kans op 1–2 stokken | uniform 0–2 | idem |

Open (gemeld, niet gefixt): de lijst staat onderaan bij **Open punten**.

## 1. Speler: beweging

| Getal | BunkCraft | Minecraft | Bron | Verdict |
|---|---|---|---|---|
| Lopen | 4,32 b/s | 4,317 | Mov | gelijk |
| Sprinten | 5,61 b/s | 5,612 | Mov | gelijk |
| Sneaken | 1,295 b/s (`SNEAK_FACTOR` 0,3) | 1,295 (sneaking_speed 0,3) | Snk, Attr | fout → gefixt (was 4,32) |
| Sprinten tijdens sneaken | kan niet | kan niet | Snk | fout → gefixt |
| Sneak: niet van randen vallen, ooghoogte −0,35, hitbox 1,5 | ontbreekt | ja | Snk | fout → open (nieuw gedrag, M) |
| Zwemmen (water) | 2,4 b/s, geen sprint-zwemmen | ~2,0 lopend in water; sprint-zwemmen 5,6 | Mov | bewust anders / sprint-zwemmen ontbreekt |
| Vliegen / sprint-vliegen | 10,9 / 21,6 b/s | 10,92 / 21,6 | Mov | gelijk |
| Vliegen verticaal | 7,5 b/s | ~7,5 | Mov | gelijk |
| Springhoogte | ~1,25 blok (v 8,9, g 30, 60 Hz) | 1,2522 (jump 0,42, gravity 0,08) | Attr | gelijk (test) |
| Zwaartekracht / max. valsnelheid | 30 b/s², 60 b/s | 0,08 b/t² met drag 0,98 → ~78,4 b/s | Attr | bewust anders (alleen eindsnelheid; valschade gaat op afstand) |
| Staphoogte | 0,6 | 0,6 (step_height) | Attr | gelijk |
| Ooghoogte / hitbox | 1,62 / 0,6 × 1,8 | 1,62 / 0,6 × 1,8 | Attr | gelijk |
| Blokbereik survival / creative | 4,5 / 5 | 4,5 / 5 (block_interaction_range) | Attr | fout → gefixt (was 5 in beide) |
| Entitybereik survival / creative | 3 / 3 | 3 / 5 (entity_interaction_range) | Attr | fout → open (aanvalscode, combat-pijplijn) |
| Ladder op / af | 3,5 / 3 b/s | 2,35 / 3 b/s | https://minecraft.wiki/w/Ladder | bewust anders (klimt iets sneller) |
| Wachttijd tussen blokken breken | 0,3 s (survival), 0,18 s (creative) | 6 ticks = 0,3 s; geen wachttijd bij instant-blokken | Brk | gelijk survival; instant-blokken krijgen ten onrechte ook 0,3 s → open (klein) |

## 2. Speler: health, honger, schade

| Getal | BunkCraft | Minecraft | Bron | Verdict |
|---|---|---|---|---|
| Max health / honger / start-saturatie | 20 / 20 / 5 | 20 / 20 / 5 | Hun | gelijk |
| Uitputting: sprint / zwem / sprong / sprint-sprong | 0,1/m / 0,01/m / 0,05 / 0,2 | idem | Hun | gelijk |
| Uitputting: blok breken / aanval / schade | 0,005 / 0,1 / 0,1 | idem | Hun | gelijk |
| Uitputting → saturatie/honger, cap | per 4,0; cap 40 | idem | Hun | gelijk |
| Natuurlijke regen | honger ≥ 18: 1 HP / 80 ticks, 6 uitputting | idem | Hun | gelijk |
| Saturatie-boost | 10 ticks, `min(sat,6)/6` HP, `min(sat,6)` uitputting | idem (`FoodData.tick`) | Hun | fout → gefixt (was vast 1 HP / 6) |
| Regen-timer | reset als regen/verhongeren niet geldt | idem | Hun | fout → gefixt (liep door → direct helen na treffer) |
| Verhongeren | 1 / 80 ticks, Normal stopt op 1 HP, Hardcore doodt | idem (Easy stopt op 10: geen difficulty) | Hun | gelijk |
| Sprinten vanaf honger | > 6 | > 6 | Hun | gelijk |
| Eettijd | 1,6 s | 32 ticks | Food | gelijk |
| Gouden appel bij volle honger | kan niet | kan altijd (`can_always_eat`) | Food | fout → open (klein; hangt aan effecten) |
| Valschade | `ceil(afstand − 3)` | `ceil(afstand − safe_fall_distance 3)` | Dmg, Attr | gelijk |
| Verdrinken | 300 lucht, dan 2 HP per 20 ticks; +4 lucht/tick erboven | idem (MECHANICS twijfelde: code klopt) | Dmg | gelijk |
| Lava | 4 HP per 10 ticks (via i-frames), 15 s brand | idem | Dmg | gelijk |
| Brand | 1 HP / 20 ticks, water blust | idem | Dmg | gelijk |
| Cactus / stikken | 1 HP met i-frames / 1 per 10 ticks | idem | Dmg | gelijk |
| Gif (spinnenoog) | 100 ticks, 1 HP / 25 ticks, niet onder 1 HP | Poison 5 s, idem | Food | gelijk |
| Bliksem | 5 HP, 8 s brand, 3 blokken | 5 HP + brand | Wea | gelijk |
| Void | `y < −64`, 4 HP / 10 ticks | 64 onder wereldbodem, 4 per 10 ticks | Void | bewust anders: onder y 0 geeft `World.getBlock` bedrock, dus de void is in survival onbereikbaar (alleen spectator/noclip, en die neemt geen schade). Geen bug, wel dode code |
| Invulnerability | 10 ticks, sterkere klap telt het verschil | idem | Dmg | gelijk |
| Harnasformule | `min(20, max(a/5, a − d/(2+t/4)))/25` | idem | Arm | gelijk |
| Harnasslijtage | `max(1, floor(d/4))` per stuk | idem | Arm | gelijk |
| Welke schade harnas negeert | val, verdrinken, honger, stikken, void, gif, bliksem; branden wordt wél verminderd | tag `bypasses_armor`: o.a. val, verdrinken, honger, stikken, void, magie én `on_fire` (branden); bliksem wordt verminderd | Dmg | fout → open: `'fire'` (branden) hoort harnas te negeren en `'lightning'` hoort erdoor verminderd te worden (`ARMOR_CAUSES` in `Armor.ts`, schade-pijplijn) |
| Hartjes in de HUD | `ceil(health)` | idem | Hun | fout → gefixt (fractionele health na harnas toonde het halve hart leeg) |

## 3. Gereedschap, mijnen, slijtage

| Getal | BunkCraft | Minecraft | Bron | Verdict |
|---|---|---|---|---|
| Snelheid hout/steen/ijzer/diamant/goud | 2 / 4 / 6 / 8 / 12 | idem | Tool | gelijk |
| Durability | 59 / 131 / 250 / 1561 / 32 | idem | Tool | gelijk |
| Harvest-level | 0 / 1 / 2 / 3 / 0 | idem | Tool | gelijk |
| Schaar | durability 238; wol 5, bladeren/web 15 | idem | https://minecraft.wiki/w/Shears | gelijk |
| Zwaard op web / andere blokken | 15 / 1 | 15 / 1,5 op planten, bladeren, pompoenen | https://minecraft.wiki/w/Sword | fout → open (klein) |
| Breekformule | `speed/hardheid/(30 of 100)`, ÷5 lucht, ÷5 water, ceil op ticks | idem | Brk | gelijk |
| Slijtage per blok | 1; zwaard 2; 0 bij hardheid 0 | idem (tool-component) | Brk | fout → gefixt (was 1 voor alles, ook fakkels) |
| Slijtage als wapen | zwaard 1, ander gereedschap 2 | idem | Tool | gelijk |
| Hardheid (alle 180 blokken nagelopen) | steen 1,5, cobble 2, erts 3, obsidiaan 50, oven 3,5, werkbank 2,5, deepslate 3 / 3,5, metaalblokken 3–5, terracotta 1,25, beton 1,8, ... | idem | https://minecraft.wiki/w/Breaking#Blocks_by_hardness | gelijk |
| Ladder: gereedschap | geen | bijl | https://minecraft.wiki/w/Ladder | fout → open (klein) |
| Web met schaar | dropt draad | dropt web | https://minecraft.wiki/w/Cobweb | fout → open (klein) |

## 4. Wapens en gevecht (gemeld, niet aangeraakt)

| Getal | BunkCraft | Minecraft | Bron | Verdict |
|---|---|---|---|---|
| Zwaard-schade hout..goud | 4 / 5 / 6 / 7 / 4 | idem | https://minecraft.wiki/w/Sword | gelijk |
| Bijl-schade | 7 / 9 / 9 / 9 / 7 | idem | https://minecraft.wiki/w/Axe | gelijk |
| Houweel / schop / schoffel / vuist | 2–5 / 2,5–5,5 / 1 / 1 | idem | Tool | gelijk |
| Aanvals-cooldown, crit, sweep | ontbreken (elke klik volle schade) | `20/speed` ticks, ×1,5 crit, sweep | https://minecraft.wiki/w/Damage | fout → open (combat-herschrijving) |
| Knockback op mobs | 6 b/s horizontaal + 6 omhoog, sprint ×1,6 | ~0,4 b/t ≈ 8 b/s, sprint +1 niveau | https://minecraft.wiki/w/Knockback_(mechanic) | bewust anders (recent zachter gezet) → combat-pijplijn |
| Mob-melee interval | 20 ticks | 20 ticks | Zom | gelijk |
| Mob-melee bereik | `1,4 + breedte/2` (zombie 1,7) | `√((2·breedte)² + doelbreedte)` ≈ 1,43 | Zom | bewust anders (benadering) |
| Boog: kracht | `(f²+2f)/3`, f in s, min 0,1, pijl 3·kracht b/t | idem | Bow | gelijk |
| Pijl: zwaartekracht / drag / water | 0,05 / 0,99 / 0,6 | idem | Arr | gelijk |
| Pijl: schade | `ceil(v·2)` + crit `rand(0..d/2+1)` | idem | Arr | gelijk |
| Pijl blijft steken | 1200 ticks | 1200 | Arr | gelijk |
| Boog durability | 384 | 384 | Bow | gelijk |
| Skeletpijl | snelheid 1,6, onnauwkeurigheid 6 (Normal) | `14 − 4·difficulty` = 6 | Ske | gelijk |
| Skeletpijl schade | ~4 (ceil(1,6·2)) | Normal 3,5–5 | Ske | gelijk (binnen bereik) |
| Mob-armor (zombie 2) | ontbreekt | zombie 2 armor | Zom | fout → open (schade-pijplijn) |

## 5. Harnas

| Getal | BunkCraft | Minecraft | Bron | Verdict |
|---|---|---|---|---|
| Punten leer / maliën / ijzer / goud / diamant | 1-3-2-1 / 2-5-4-1 / 2-6-5-2 / 2-5-3-1 / 3-8-6-3 | idem (maliën = 12, niet 14) | Arm | gelijk |
| Toughness diamant | 2 per stuk | 2 | Arm | gelijk |
| Durability = basis 11/16/15/13 × | 5 / 15 / 15 / 7 / 33 | idem (leer 55/80/75/65, diamant 363/528/495/429) | Arm | gelijk |

## 6. Mobs

Snelheid in b/s afgeleid uit het attribuut: mobs zetten `zza = speed`, dus `v ≈ 44 · (attr · modifier)²` (speler 0,1 × 0,98 → 4,317).
Dat is een benadering; daarom staan snelheden als **bewust anders** zolang ze binnen ~25% liggen.

| Mob | Getal | BunkCraft | Minecraft | Bron | Verdict |
|---|---|---|---|---|---|
| Varken | HP / maat / drops | 10 / 0,9×0,9 / 1–3 varkensvlees | idem | https://minecraft.wiki/w/Pig | gelijk |
| Koe | HP / maat | 10 / 0,9×1,4 | idem | Cow | gelijk |
| Koe | drops | 1–3 rundvlees + 0–2 leer | idem | Cow | fout → gefixt (leer ontbrak) |
| Schaap | HP / maat / drops | 8 / 0,9×1,3 / 1 wol + 1–2 schapenvlees | idem | https://minecraft.wiki/w/Sheep | gelijk |
| Kip | HP / maat / drops / valschade | 4 / 0,4×0,7 / 1 kip + 0–2 veer / geen | idem | https://minecraft.wiki/w/Chicken | gelijk |
| Zombie | HP / maat / schade | 20 / 0,6×1,95 / 3 | idem (Normal) | Zom | gelijk |
| Zombie | follow range | 35 | 35 | Attr | fout → gefixt (was 32) |
| Zombie | snelheid lopen / jagen | 1,0 / 2,6 | ~2,3 (0,23) | Attr | bewust anders |
| Zombie | drops | 0–2 rot vlees | + zeldzaam ijzer/wortel/aardappel (2,5%, spelerkill) | Zom | bewust anders (zeldzame drops ontbreken) |
| Skelet | HP / maat / follow / schietafstand | 20 / 0,6×1,99 / 16 / 15 | idem | Ske | gelijk |
| Skelet | schietritme | 40 + 20 ticks = 3 s | 3 s (Easy/Normal), 2 s (Hard) | Ske | fout → gefixt (was 1 s) |
| Skelet | drops | 0–2 bot, 0–2 pijl | idem | Ske | gelijk |
| Creeper | HP / maat / follow | 20 / 0,6×1,7 / 16 | idem | Cre, Attr | gelijk |
| Creeper | lont / start / afbreken | 30 ticks / < 3 / > 7 blokken | idem | Cre | gelijk |
| Creeper | explosiekracht / drops | 3 / 0–2 buskruit | idem | Cre | gelijk |
| Spin | HP / maat / schade | 16 / 1,4×0,9 / 2 | idem | Spi | gelijk |
| Spin | follow range | 16 | 16 | Attr | fout → gefixt (was 32) |
| Spin | neutraal bij licht | ≥ 12 | brightness ≥ 0,5 ≈ licht 12 | Spi | gelijk |
| Spin | sprong / klimmen | 0,4 b/t / 0,2 b/t | idem | Spi | gelijk |
| Spin | drops | 0–2 draad, 1/3 spinnenoog (spelerkill) | idem | Spi | gelijk |
| Alle | i-frames / valschade | 10 ticks / `ceil(val − 3)` | idem | Dmg | gelijk |
| Brandend in zon | 1 HP / s, zon = sky light > 11 | 8 s in brand, 1 HP/s | Zom | gelijk (benadering) |
| Lava | 4 HP / 10 ticks | idem | Dmg | gelijk |

## 7. Spawnen en despawnen

| Getal | BunkCraft | Minecraft | Bron | Verdict |
|---|---|---|---|---|
| Lichtregel monsters | block light 0, sky ≤ rand(0..7) | idem (`monster_spawn_light_level`) | Spn | gelijk |
| Lichtregel dieren | ≥ 9 op gras | > 8 op gras | Spn | gelijk |
| Gewichten monsters | 100 elk | zombie 95 (+5 zombie-villager), skelet/creeper/spin 100 | Spn | gelijk (benadering) |
| Packgrootte monsters | zombie 2–4, skelet 2–3, creeper 1, spin 1–2 | 4 per pack (pogingen per mob) | Spn | bewust anders (`b185ac0`: kleinere packs) |
| Cap monsters | 18 (+8/speler, max 48) | 70 per 289 chunks | Spn | bewust anders (kleinere ring) |
| Spawnafstand | 28–64 | 24–128 | Spn | bewust anders |
| Despawn | > 128 direct, > 32 met 1/800 per tick | idem | Spn | gelijk |
| Dag-opruiming | 1/240 per tick in open zon buiten 32 | bestaat niet | – | bewust anders (gedocumenteerd in GAMEPLAY.md) |
| Dieren | 25% per chunk bij generatie, gewichten 12/10/10/8, top-up elke 200 ticks | ~10% per chunk, gewichten idem, elke 400 ticks | Spn | bewust anders |

## 8. Voedsel

Alle 30 voedingswaarden (honger / saturatie) nagelopen tegen Food: varken/rund 3/1,8, schaap/kip 2/1,2, rot vlees 4/0,8,
gebakken varken/steak 8/12,8, gebakken schaap 6/9,6, gebakken kip 6/7,2, appel 4/2,4, gouden appel 4/9,6, brood 5/6, koekje 2/0,4,
aardappel 1/0,6, gebakken aardappel 5/6, wortel 3/3,6, gouden wortel 6/14,4, meloen 2/1,2, pompoentaart 8/4,8, stoofpot 6/7,2,
kabeljauw 2/0,4 (gebakken 5/6), zalm 2/0,4 (gebakken 6/9,6), bessen 2/0,4, biet 1/1,2, konijn 3/1,8 (gebakken 5/6), spinnenoog 2/3,2.
**Verdict: gelijk.** Effecten (kip 30% Hunger, rot vlees 80% Hunger, gouden appel Absorption/Regeneration) ontbreken: open, hangt aan het effectensysteem.

## 9. Blokken, drops, explosies

| Getal | BunkCraft | Minecraft | Bron | Verdict |
|---|---|---|---|---|
| Erts-drops | koper 2–5, lapis 4–9, redstone 4–5, overige 1 | idem | https://minecraft.wiki/w/Ore | gelijk |
| Glowstone / klei / sneeuwblok / meloen | 2–4 / 4 / 4 / 3–7 | idem | – | gelijk |
| Bladeren | sapling 5% (jungle 2,5%), stok 2% (1–2), appel 0,5% | idem | https://minecraft.wiki/w/Leaves | gelijk |
| Grind → vuursteen | 10% | 10% | https://minecraft.wiki/w/Gravel | gelijk |
| Hoog gras → zaad | 12,5% | 12,5% | https://minecraft.wiki/w/Grass | gelijk |
| Dode struik | uniform 0–2 stokken | 0–2 | DB | fout → gefixt (was 50% × 1–2) |
| TNT | lont 80, kracht 4, kettinglont 10–29, sprong 0,02/0,2 b/t | idem | TNT | gelijk |
| Explosieschade speler | `floor(7P(i²+i)+1)`, i = 1 − d/2P | idem (zonder exposure) | Exp | gelijk (exposure ontbreekt: bewust anders) |
| Explosieschade mobs | idem als speler | idem | Exp | fout → gefixt (was `floor((1−d/2P)·7P)`, client + server) |
| Explosie-drops | TNT 100%, overige 1/kracht | idem (1.21) | Exp | fout → gefixt (TNT was 25%) |
| Blokvernietiging | ruisbol met straal 1,3·P, alleen bedrock/obsidiaan/vloeistof blijven | stralen met blast resistance | Exp | bewust anders (benadering; steen sneuvelt even makkelijk als aarde) |

## 10. Stapels, smelten, tijd, weer

| Getal | BunkCraft | Minecraft | Bron | Verdict |
|---|---|---|---|---|
| Blokken / meeste items | 64 | 64 | Stack | gelijk |
| Bed | 1 | 1 | Bed | fout → gefixt (was 64) |
| Lege emmer / sneeuwbal | 16 / 16 | 16 / 16 | Stack | gelijk |
| Volle emmer, tools, harnas, boog, stoofpot | 1 | 1 | Stack | gelijk |
| Smelten | direct, 1 brandstof per resultaat | 200 ticks per item; kool 8 items, plank 1,5 | Smelt | bewust anders (receptenlijst; oven-block-entity is roadmap) |
| Daglengte | 1200 s (24 000 ticks), tick 0 = 06:00 | idem | Day | gelijk |
| Regen aan / uit | 12 000–24 000 / 12 000–180 000 ticks | idem | Wea | gelijk |
| Onweer aan | 3 600–15 600 ticks | idem | Wea | gelijk |
| Item-despawn / oppak-vertraging | 6000 / 10 ticks (gegooid 40) | idem | https://minecraft.wiki/w/Item_(entity) | gelijk |
| Vloeistoffen | water 1 blok / 5 ticks (7 ver), lava 30 ticks (3 ver) | idem | https://minecraft.wiki/w/Water | gelijk |

## Open punten (niet gefixt)

Combat-/schade-pijplijn (andere ontwikkelaar, alleen gemeld):
1. Geen aanvals-cooldown, crit of sweep (`Interaction.attack`).
2. Entitybereik in creative hoort 5 te zijn (nu 3).
3. `ARMOR_CAUSES`: branden (`'fire'`) hoort harnas te negeren, bliksem (`'lightning'`) hoort erdoor verminderd te worden.
4. Zombies missen hun 2 natuurlijke armor; mobs hebben geen armor-model.
5. Knockback op mobs (6 b/s) is zachter dan vanilla (~8); bewust in `b185ac0`, maar het hoort bij de combat-herziening.

Klein, buiten de pijplijn (los op te pakken):
6. Sneaken: randbescherming, lagere ooghoogte en hitbox 1,5 ontbreken (alleen de snelheid is nu vanilla).
7. Sprint-zwemmen ontbreekt.
8. Instant-blokken (fakkel, bloem) krijgen na het breken toch 0,3 s wachttijd.
9. Zwaard hakt planten/bladeren niet 1,5× sneller; ladder heeft geen bijl als gereedschap; web met schaar dropt draad i.p.v. web.
10. Gouden appel is niet eetbaar met volle honger.
11. Void-schade is onbereikbaar (bedrock onder y 0); kan weg of blijven als vangnet.
12. Mob-loopsnelheden zijn met de hand gekozen; een herberekening uit de attributen (formule hierboven) zou ze binnen ~10% van vanilla brengen.
