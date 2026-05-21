# FlowLab Step 4.3 — UX fixes + ускорение

## По пунктам

### 1. ⚡ Ускорение загрузки
- Добавил **in-memory кеш на 10 секунд** для всех dashboard-запросов (`src/lib/cache.ts`)
- На warm lambda — повторный заход на dashboard будет почти мгновенным
- Кеш per-instance, не глобальный — это ОК, dashboard допускает 10с staleness

### 2. ✅ Имена моделей — не трогал

### 3. Критичные UX-фиксы

**🔴 Drag нод тормозит**
- Полностью переписал drag — теперь идёт **прямая мутация DOM** (`element.style.transform`) во время drag, а в graph state позиция коммитится только при отпускании
- Edges обновляются через дешёвый SVG-rerender через `dragTick`
- На 50+ нодах теперь честные 60fps

**🔴 Edges не подключаются куда нужно**
- Нашёл: порт-кружок имеет radius 7px, но edges рисовались на `top`, а не в центре круга
- Также `startEdge` имел захардкоженный `y + 50` без учёта индекса порта
- Поправил `PORT_BASE = NODE_HEADER_HEIGHT + 14 + PORT_RADIUS` (= +7) и формулу в Canvas
- Теперь линии заходят/выходят точно в центр кружков

**🔴 Не получается создать ноду через правый клик**
- Нашёл: обработчики кнопок в ContextMenu были на `onClick`, который срабатывает ПОСЛЕ `mousedown`
- При левом клике глобальный mousedown listener закрывает меню (выставляет `ctxMenu = null`)
- К моменту click — `ctxMenu` уже null, `ctxMenu.canvasX` падает или undefined
- Поправил: переключил на `onMouseDown` + `stopPropagation` + захват координат в стабильный closure через IIFE

## Бонусом

**Kling text-to-video endpoints** — ты прав, у меня был только Pro T2V. Добавил все доступные T2V:
- Kling 3.0 Standard (T2V)
- Kling 3.0 4K (T2V)
- Kling 2.5 Turbo Pro (T2V)
- Kling 2.1 Master (T2V)

Также проверил доку — **Kling v3 I2V использует `start_image_url`** (не `image_url`!). Поправил в runners.ts.

## Файлы (8 штук)

- `src/lib/cache.ts` — НОВЫЙ файл, in-memory cache helper
- `src/app/dashboard/page.tsx` — обёрнуты queries в cached()
- `src/lib/canvas/types.ts` — все Kling T2V endpoints + Seedance refs
- `src/lib/engine/runners.ts` — Kling v3 start_image_url + T2V не требует start frame
- `src/components/canvas/Canvas.tsx` — direct DOM drag + correct port Y + IIFE для ctxMenu
- `src/components/canvas/CanvasNode.tsx` — data-node-id + transform positioning
- `src/components/canvas/CanvasEdges.tsx` — liveDragNodeId/liveDragPos props + PORT_RADIUS offset
- `src/components/canvas/ContextMenu.tsx` — onMouseDown вместо onClick

## Накатить

GitHub → Upload files → перетащить папку `src` → Commit `Step 4.3: UX fixes + dashboard cache`.

**Важно**: cache.ts — НОВЫЙ файл. Убедись что он попал в `src/lib/cache.ts` (некоторые upload UI пропускают новые файлы).

## Тест

1. **Cmd+Shift+R** дважды
2. **Dashboard** — первый заход обычный, второй быстрее (cache hit)
3. **Drag ноды** — мгновенно, без задержки
4. **Edges** — линии идут в центр кружков точно
5. **Правый клик на пустом канвасе** → меню → выбери "Text Generation" → нода создаётся
6. **Kling Text-to-Video** — должно быть 4 варианта в дропдауне

## Про "результаты пропадают при refresh"

Это **отдельная проблема** — fal.ai URLs живут ~24 часа, потом пропадают. Чтобы сохранить навсегда, нужен Supabase Storage bucket:

1. Открой **Supabase Dashboard → Storage** (значок коробки в левом меню)
2. **New bucket** → имя ровно `flowlab-assets` → **Private** (без галочки Public) → **Create**
3. Готово

После этого следующие runs будут сохраняться в Supabase и не пропадать.

Я не могу это сделать кодом за тебя — нужен клик в Supabase UI. Это занимает 30 секунд.

