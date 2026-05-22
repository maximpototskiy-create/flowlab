# FlowLab Step 4.5 — Архитектурный фикс: конкурентные runs, polling leak, edges, ContextMenu, ConnectionPicker

## Корень проблем

Ты сообщил: после первой генерации перестают коннектиться edges, ConnectionPicker не создаёт ноду, ContextMenu тоже, новый воркфлоу сыпет 500-ками. Я полез в логи и **нашёл реальную причину каскада**.

### Главная находка из логов

В логах вижу `POST /api/runs/start` **7 раз за 5 секунд**, потом `prisma:error Timed out fetching connection from the pool (limit: 5)` тоже **7+ раз**. И GET `/api/runs/<old_id>` бьётся даже после того как ты ушёл на другой воркфлоу.

**Что происходило:**
1. Ты жал ▶ на разных нодах подряд → 7 параллельных runs
2. Каждый run заводит **polling interval 4сек** → 7 интервалов одновременно
3. При смене воркфлоу старые интервалы НЕ убивались → продолжали бить /api/runs/[id]
4. + auto-save graph каждые N секунд
5. Connection pool забит → все запросы 500 → "Save failed"
6. Page re-renders → state в Canvas теряется → edges не подключаются, drag сбивается, ContextMenu/ConnectionPicker race с outside-click-close

## Фиксы

### 🔴 Polling leak — главный убийца
Добавил **cleanup useEffect** который при unmount Canvas (закрытие воркфлоу, навигация) убивает ВСЕ активные polling intervals. Раньше они жили вечно.

### 🔴 Duplicate runs — kasкадный спам
Добавил `inflightScopes` Set. Если жмёшь ▶ на ноду где run уже идёт — игнорим. Раньше можно было настрелять 10 одновременных.

### 🔴 Pointer listeners пересоздавались на каждый render
useEffect для onMove/onUp depends на `[drag, edgeDraft, isPanning, zoom, screenToCanvas]`. Каждый polling tick → setGraph → re-render → effect пересоздаётся → window listeners снимаются и навешиваются заново. Если в этот момент юзер двигал мышью посреди drag — **events пропадают**.

**Фикс:** все mutable state теперь читается через **stable refs**, listeners ставятся **один раз на mount**. Drag, edges, pan теперь не сбиваются при polling.

### 🔴 Connection pool — финальный размер
Скакал 1→10→5. По официальной доке Supabase для serverless — **connection_limit=1**. Supavisor (pgBouncer) мультиплексирует на стороне сервера, нам не нужны множественные коннекшены на лямбду.

С `cached()` (10s TTL) параллельные dashboard-запросы из 1 лямбды теперь сериализуются Prisma и не упираются в timeout.

### 🔴 ConnectionPicker — нода не создавалась
Та же проблема как с ContextMenu в прошлом patch: `onClick` срабатывает после `mousedown`, а global outside-click-close listener успевал закрыть picker и обнулить state до того как onClick доходил до addNodeAt. Заменил на `onMouseDown` + `stopPropagation` + IIFE capture coords.

### 🟡 Edges не в центре кружков
Я ставил `NODE_HEADER_HEIGHT = 38`, а реальная высота `h-9 + border-b-1` = 37, визуально ближе к 36. Поправил константу и захардкоженное `38` в `startEdge`.

### 🟡 Логирование Storage
Сейчас при падении uploadFromUrl мы тихо возвращали fal URL. Теперь печатаем **точную ошибку в Vercel logs**: `[persistAsset] STORAGE FAILED for <path>: <message>`. Когда после деплоя сделаешь генерацию, в Vercel logs увидим почему bucket не работает (если service_role_key не работает / bucket policy / etc).

## Про "изображения пропадают"

Ситуация: fal.ai URL живёт ~24ч (часто меньше). Пока не работает Supabase Storage — после refresh картинки/видео исчезают.

`ensureBucket()` уже есть и должен создавать бакет автоматически при первой попытке. Но скорее всего падает по какой-то причине. **После деплоя сделай 1 генерацию → пришли мне Vercel logs за этот момент** — увижу строку `[persistAsset] STORAGE FAILED` и сразу починю.

Альтернатива на 30 секунд: Supabase Dashboard → Storage → New bucket → `flowlab-assets` → Private. После этого автоматически заработает.

## Файлы (4 штуки)

- `src/lib/prisma.ts` — connection_limit=1 (по officialному совету Supabase)
- `src/components/canvas/Canvas.tsx` — polling cleanup, inflightScopes, stable refs, IIFE capture, header height fix
- `src/components/canvas/CanvasNode.tsx` — NODE_HEADER_HEIGHT 38 → 36
- `src/components/canvas/ConnectionPicker.tsx` — onMouseDown + stopPropagation
- `src/lib/engine/runners.ts` — улучшенное storage logging

## Накатить

GitHub → Upload files → перетащить папку `src` → Commit `Step 4.5: concurrent runs + polling leak + UX`.

## Тест

1. Cmd+Shift+R
2. **Polling cleanup:** запусти ▶, перейди на другой workflow → в Vercel logs больше не должно быть бесконечных GET /api/runs/[id]
3. **No duplicate runs:** жми ▶ много раз подряд → запустится только один run
4. **Edges после генерации:** запусти ноду, дождись результата, попробуй добавить новую ноду + edge → должно работать (раньше после генерации drag/edges ломались)
5. **ConnectionPicker:** тяни линию от ноды в пустое место → меню → выбери ноду → ноды соединятся
6. **Save не падает:** работай 5 минут активно — никаких "Save failed" в углу
7. **Edges по центру:** линии должны входить точно в центр кружков

## Что после этого

Когда увижу что storage логирование показывает (после твоей генерации) — поправлю окончательно проблему "изображения пропадают". Это последний оставшийся 🟡 пункт.

