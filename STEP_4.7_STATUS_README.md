# 👀 Step 4.7 — Статусы генераций видны везде

## Что чинит

| Что | Раньше | Теперь |
|-----|--------|--------|
| Запустил генерацию → ушёл в dashboard | Никакого индикатора | TopNav показывает `● 2 running` с dropdown |
| Запустил → ушёл в другой workflow | Не видно что где-то идёт | В CanvasToolbar бейдж `1 elsewhere` с dropdown |
| Запустил → ушёл → вернулся (run ещё не закончен) | Ноды пустые, статус потерян | Ноды сразу показывают спиннеры на нужных нодах |
| Жмёшь Run | Бейдж появляется через 5 сек | Бейдж появляется мгновенно |

## Архитектура

```
                 ┌─────────────────────────────────┐
                 │  GET /api/runs/active           │
                 │  (single SELECT с join по       │
                 │   workflow → project → brand)   │
                 └────────────┬────────────────────┘
                              │
                 ┌────────────▼────────────────────┐
                 │  ActiveRunsStore (singleton)    │
                 │  - polls 5s only when ≥1 sub    │
                 │  - shared by all consumers      │
                 └────────────┬────────────────────┘
                              │ useActiveRuns()
            ┌─────────────────┼─────────────────────┐
            ▼                 ▼                     ▼
   ActiveRunsIndicator   OtherActiveRunsBadge   (Canvas tracks
   (TopNav, везде        (CanvasToolbar,           via separate
   кроме canvas)         только в workflow)        polling of its
                                                   own run)
```

**Ключевые свойства:**
- **Один источник данных** — все индикаторы тянут из одного store. Открыл dashboard в одной вкладке и workflow в другой? — обе вкладки независимо поллят, но в каждой вкладке только один polling, не несколько.
- **Polling умный** — крутится только когда есть мин 1 subscriber И мин 1 active run. Зашёл на статичную страницу без runs — никакого траффика.
- **`pokeActiveRuns()`** — вызывается при старте нового run, заставляет store сразу refetch. Бейдж появляется через ~100мс, а не через 5с цикла.

## Что в патче (7 файлов)

| Файл | Изменение |
|------|-----------|
| 🆕 `src/app/api/runs/active/route.ts` | Новый endpoint — returns active runs for current user |
| 🆕 `src/components/ActiveRunsIndicator.tsx` | TopNav badge + общий store + `useActiveRuns` hook + `pokeActiveRuns` |
| 🆕 `src/components/canvas/OtherActiveRunsBadge.tsx` | Бейдж в CanvasToolbar — показывает active runs в ДРУГИХ workflows |
| ✏️ `src/components/TopNav.tsx` | Добавлен `<ActiveRunsIndicator />` |
| ✏️ `src/components/canvas/CanvasToolbar.tsx` | Добавлен `<OtherActiveRunsBadge />` |
| ✏️ `src/app/projects/[id]/workflows/[wid]/page.tsx` | Server-side подгружает active run для workflow и передаёт в Canvas |
| ✏️ `src/components/canvas/Canvas.tsx` | Применяет initialActiveRun, сразу resume polling, poke store при старте |

## Как накатить

1. Распакуй `flowlab-step4.7-status-everywhere.zip`
2. GitHub → Upload files → перетащи папку `src`
3. GitHub скажет: **"4 files will be updated, 3 files will be added"**
4. Commit: `Step 4.7: active-runs visibility — TopNav badge + canvas resume`
5. **Commit changes**
6. Ждём Vercel build

## Тесты

### Тест #1 — TopNav бейдж
1. Запусти долгую генерацию (Video Gen)
2. Сразу клик "Dashboard" в TopNav  
3. ✅ В TopNav справа появляется `● 1 running`
4. Клик на бейдж → dropdown со списком, видно workflow и progress
5. Клик на строку → возврат в workflow

### Тест #2 — Resume статусов
1. Запусти генерацию (n_xxx — video gen)
2. Сразу уйди в другой workflow (или dashboard → обратно)  
3. Вернись в исходный workflow
4. ✅ На n_xxx сразу видна "running" анимация, без задержки 5с
5. Когда run закончится → автоматически обновится на "done" с результатом

### Тест #3 — Бейдж в Workflow toolbar
1. Workflow A: запусти генерацию
2. Workflow B: открой
3. ✅ В toolbar Workflow B справа `1 elsewhere`
4. Клик → dropdown с Workflow A
5. Клик на строку → переход в Workflow A

### Тест #4 — Бейдж пропадает корректно
1. Дождись окончания всех runs
2. ✅ Бейдж в TopNav исчезает (никакого "0 running")
3. ✅ Polling стопается — `Network` tab в DevTools не показывает запросов к `/api/runs/active`

### Тест #5 — Несколько одновременно
1. В разных workflows запусти 2-3 генерации
2. ✅ TopNav: `● 3 running`
3. ✅ Каждый workflow: показывает свои running ноды + `2 elsewhere`

## Что НЕ в патче (на следующий раз)

| Запрос | Статус |
|--------|--------|
| Скорость "в несколько раз быстрее" | Только Vercel Pro + Supabase Pro даст реальный прирост. Скажи когда захочешь обсудить апгрейд |
| Multimodal ImageGen (несколько image inputs) | Отдельный патч — большая работа над runners/types/UI |
| Aspect/duration баг | Отдельный патч — нужно посмотреть как fal.ai вызывает |
| Группировка нод | Отдельный патч — UI feature |

Я хочу сделать сначала **multimodal + aspect/duration** одним патчем — это самые impactful для качества генераций. Дай зелёный свет когда протестируешь этот.

## Технические детали

### Почему cdn-нагрузка от polling минимальна
- Endpoint делает 1 SELECT с join. На таблицу `runs` есть индекс по `triggeredBy` + filter по `status` (Postgres использует его эффективно).
- Polling каждые 5с — это 12 запросов в минуту. Даже при connection_limit=3 это не проблема.
- При отсутствии active runs polling стопается, нагрузка 0.

### Почему "10 минут таймаут" в /api/runs/active
Vercel Hobby максимум 300с на функцию. Если run "running" больше 10 минут — это призрак: лямбда была убита, executor не успел пометить run как error. Мы прячем такие runs из бейджа (но не удаляем — пусть админка увидит). Это защита от "бейдж всегда показывает 1 running после краша лямбды".

### Почему shared store, а не Context
Поскольку TopNav — server component, передать React Context "вниз" в его дочерний `ActiveRunsIndicator` (client component) сложно. Module-level singleton проще, и работает между разными деревьями (TopNav + CanvasToolbar — разные ветки) без provider'ов.
