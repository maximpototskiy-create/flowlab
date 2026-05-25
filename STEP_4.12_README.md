# 🎨 Step 4.12 — Brand Kit полностью подключен

**7 файлов** (1 новый API + 1 новый компонент + 5 правок).

## Что было сломано

Ты в 4.11 заполнил Brand Kit — pitch, иконку, App Store ссылку, **14 скриншотов** — а LLM и Nano Banana игнорировали их. Я сделал только текстовую часть бренда (`ctx.brandVoice`), а **UI скриншоты в БД лежали мёртвым грузом**: никакая нода их не читала и не использовала.

## Что исправлено

### 1. Auto-inject скриншотов во ВСЕ relevant ноды

`runs/start` теперь подгружает screenshots из brand kit (через `getBrandUiScreenshots`) и кладёт в `ctx.brandUiScreenshots`. Дальше:

**В imageGen runner** (Nano Banana, GPT Image, FLUX и др.):
- Если у ноды НЕТ собственных reference images upstream → автоматически добавляются brand screenshots как refs
- Для Nano Banana это переключает на `/edit` endpoint
- Cap 14 (документированный максимум Nano Banana)

**В LLM runners** (Text Generation и пр.):
- То же самое: если нет своих images, brand screenshots уходят в vision-input как images
- Claude/GPT/Gemini увидят реальный UI приложения при написании промптов

**Правило "user override"**: если пользователь сам подключил reference images через edges — brand screenshots **не** инжектятся. Не мешает пользователю генерировать что-то off-brand.

### 2. Новая нода **Brand Assets**

Когда нужен явный контроль (например, передать ТОЛЬКО конкретные 3 скриншота из 14), создаёшь Brand Assets ноду:

- Категория: **Image**, иконка: **package**
- Сразу подгружает все UI screenshots бренда
- Grid 3-в-ряд с миниатюрами 9:16
- Чекбоксы — выбираешь любые
- Кнопки **All** / **None**
- При **0 выбранных** → forwards ВСЕ (это "включить всё")
- При выбранных → ровно эти
- Выбор сохраняется в `node.config.selected`, переживает refresh
- Output port `images` → подключаешь к `images` multi-port любой downstream ноды (LLM, ImageGen)

### 3. Спец-логика multi-port для Brand Assets

`resolveInputs` в executor расширен: когда edge идёт **от brandAssets ноды к multi-port** → раскрывает весь `results[]` массив в multi-port (а не один URL). То есть подключив **одно** ребро от Brand Assets, ты дашь downstream-ноде **все выбранные** скриншоты.

### Brand Assets vs Auto-inject (важная связка)

Когда **Brand Assets нода в графе** и подключена к downstream:
- downstream получает `userImages.length > 0` (потому что Brand Assets considered "user-provided")
- → auto-inject ctx.brandUiScreenshots **отключается**
- → только выбранные через Brand Assets идут как refs
- → НО brandVoice (текстовый бриф) **всё равно работает** — это разные механизмы

Это ровно то что ты просил: "опционально такая нода, которая выбирает нужные скрины, при этом все остальное из bk учитывается".

## Файлы

```
src/lib/engine/runners.ts                       ← auto-inject + brandAssets case
src/lib/engine/executor.ts                      ← multi-port expansion для brandAssets
src/lib/canvas/types.ts                         ← brandAssets node type + custom union
src/app/api/runs/start/route.ts                 ← load screenshots в ctx
src/app/api/brand-assets/[brandId]/route.ts     ← NEW endpoint для picker
src/components/canvas/CanvasNode.tsx            ← custom branch для brand-assets
src/components/canvas/BrandAssetsPicker.tsx     ← NEW client component
```

## Как накатить

1. Распакуй `flowlab-step4.12-brand-kit-wired.zip`
2. GitHub → Upload files → перетащи `src` (там новые папки и файлы)
3. GitHub скажет "5 updated + 2 added"
4. Commit: `Step 4.12: brand kit fully wired — auto-inject screenshots + Brand Assets node`
5. Vercel build

⚠️ **Никаких миграций БД не нужно** — поля BrandKit уже добавлены в 4.11. Этот патч только читает их.

## Тесты

### #1 — Auto-inject (главный) 
1. Workflow в бренде Cleaner Kit (там уже 14 UI screenshots)
2. Создай **только** Text Generation, никаких других нод
3. Instructions: "напиши промпт для генерации изображения: девушка держит iPhone с открытым приложением Cleaner Kit на экране"
4. Run
5. ✅ Output должен описывать **РЕАЛЬНЫЙ UI Cleaner Kit** (зелёный круг прогресса, конкретные экраны "Space to clean", "Cleanup Complete" и т.д.) — потому что Claude увидел все 14 скриншотов

Если же без UI скриншотов модель пишет что-то generic (просто "приложение") — значит screenshots не дошли. Тогда нужно проверить логи.

### #2 — Auto-inject в Nano Banana
1. В том же workflow создай Image Generation → Nano Banana 2 → 9:16
2. Instructions: "девушка держит телефон iPhone, на экране показана главная иконка приложения cleaner kit с очисткой памяти"
3. Run
4. ✅ Сгенерируется картинка где на экране телефона ВИДНО **реальный** интерфейс Cleaner Kit (зелёный круг, цифры, текст), а не выдуманное приложение

### #3 — Brand Assets нода
1. Создай Brand Assets ноду (категория Image → "Brand Assets")
2. ✅ Сразу видишь grid из 14 скриншотов (или сколько у тебя)
3. Выбери только 3 — например, экран с "Space to clean", "Cleanup Complete", иконку
4. Подключи Brand Assets `images` → Image Generation `images` (multi-port)
5. В Image Generation: instructions "сделай рекламный баннер используя стиль приложения"
6. Run
7. ✅ Используются ТОЛЬКО эти 3 скриншота. Если убрать ноду — авто-инжект вернёт все.

### #4 — Brand Assets без выбора = все
1. Brand Assets нода → не выбирай ничего
2. Подключи к Image Gen
3. Run
4. ✅ Forwards все 14 (как auto-inject, но через явную ноду)

### #5 — Brand Voice (текст) всё ещё работает
1. Нода Text Generation в брендe
2. "напиши заголовок"
3. ✅ Output использует tone of voice, words to prefer/avoid, упоминает Cleaner Kit и продакт пич

## Известные ограничения

- **Cost**: каждый раз когда автоматически инжектится 14 screenshots в Nano Banana — это 14 input images. Если хочешь экономить, используй **Brand Assets ноду** с выбором ~3-5 нужных скриншотов.
- **Vision models price**: 14 images в Claude Opus 4.7 = ~$0.20-0.50 per call. На Haiku — пенни. Можешь временно переключаться на Haiku для черновиков промптов.
- **Икона** — попадает в общий массив скриншотов (ты загрузил её в "UI screenshots" секцию). Если хочешь отдельный слот для иконки — это next-patch, скажи.

## Что отложено

- **#4** Compact node + click-to-expand промежуточный размер
- **#7** Multi-shot для Kling V3 + Seedance 2
- **#8** Organize / minimap / group nodes

После теста этого — Multi-shot + click-to-expand одним патчем.
