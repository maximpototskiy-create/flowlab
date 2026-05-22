# 🏗️ Step 4.6.2 — Background runs + контент реально выживает refresh

## Что изменилось архитектурно

**Раньше:** результаты генерации жили только в client React state через polling. Если клиент ушёл с workflow / закрыл вкладку / refresh-ил **до** того как сработал autosave — outputs терялись. Сами файлы оставались в Supabase, но привязка "нода X → URL Y" исчезала.

**Теперь:** **сервер сам пишет outputs в `workflow.graph`** прямо в `executor.ts` сразу после каждого завершённого step'а. Клиент не нужен. Runs работают полностью фоном.

| Сценарий | Раньше | Теперь |
|----------|--------|--------|
| Запустил → дождался → F5 | 50/50 (race с autosave) | ✅ Всегда работает |
| Запустил → ушёл в другой workflow → вернулся | ❌ Пусто | ✅ Контент на месте |
| Запустил → закрыл вкладку → открыл через час | ❌ Пусто | ✅ Контент на месте |
| Идёт долгая генерация → ушёл на /dashboard | ❌ Полу-обрублено | ✅ Сервер допишет, увидишь при возврате |

## Что внутри патча

**4 файла**, все три прошлых правки 4.6 + 4.6.1 + новая архитектурная.

### `src/lib/engine/executor.ts` — НОВОЕ: server-side persist
После каждого завершённого step'а в executor делается **транзакционный merge** в `workflow.graph`:
- Читает текущий graph
- Патчит **только** этот node (его outputs/results)
- Пишет назад

Атомарно через `prisma.$transaction` — параллельные step'ы (executor запускает одну глубину параллельно) не перетирают друг друга.

Positions, configs, edges, другие nodes — **не трогаются**. То есть пока сервер пишет outputs nodeA, ты безопасно двигаешь nodeB на канвасе.

### `src/components/canvas/CanvasNode.tsx` — рендер не зависит от status
Старое условие:
```tsx
{status === "done" && node.outputs && ... && <OutputPreview ... />}
```
требовало в state иметь status="done". Но `status` намеренно НЕ сохраняется (волатильное runtime-состояние — нельзя сохранить status="running" иначе после refresh висел бы вечный спиннер). После refresh status=undefined → false → UI ничего не показывал, даже если outputs в state были.

Новое:
```tsx
{((node.outputs && Object.keys(node.outputs).length > 0) ||
  (node.results && node.results.length > 0)) && <OutputPreview ... />}
```
Условие смотрит на сами данные. Появились outputs → отображается. Безопасно при re-run (там outputs сбрасываются в undefined в startRun).

### `src/components/canvas/Canvas.tsx`
- **Fix #1**: autosave сохраняет `outputs: n.outputs, results: n.results` (закрывает "ушёл и вернулся" если по какой-то причине server-persist не сработал — defense in depth)
- **Fix #2**: snap к ближайшему input port в радиусе 40px (избавляет от мучений соединения)
- **Fix #3**: debounce 800ms → **200ms** (резко уменьшает окно race до server-persist)
- **Fix #4**: убран `key={\`edges-${dragTick}\`}` ремаунт (drag должен стать плавнее)

### `src/components/canvas/CanvasEdges.tsx`
- `overflow="visible"` на SVG (линии больше не обрезаются)
- DOM-измерение портов через `getBoundingClientRect` (edges точно в центре)
- Менее агрессивный bezier (clamp 40-140px — линии не делают огромные S-кривые)

## Как накатить

1. Распакуй `flowlab-step4.6.2-patch.zip`
2. GitHub → repo `flowlab`
3. **Add file → Upload files**
4. Перетащи папку `src` целиком
5. GitHub скажет: **"4 files will be updated"**
6. Commit: `Step 4.6.2: background runs + server-side outputs persist`
7. **Commit changes**
8. Ждём Vercel build (Ready) ~1 минута

## Тесты

### 🔴 Тест #1 — главный (refresh)
1. Запусти Image Generation → дождись картинки
2. F5
3. ✅ Картинка на месте

### 🔴 Тест #2 — фоновый run (новое поведение!)
1. Запусти долгую генерацию (Video Generation 5-10s)
2. **Сразу** уйди в другой workflow или на /dashboard
3. Подожди минуту
4. Вернись в этот workflow
5. ✅ Видео на месте

### 🔴 Тест #3 — переключение между workflows
1. Workflow A: запусти Image Generation, дождись
2. Workflow B: создай ноду, что-нибудь сгенерируй
3. Вернись в Workflow A
4. ✅ Контент A на месте

### 🟢 Тест #4 — линии и snap (повтор из 4.6)
1. Создай несколько нод
2. Соедини их — отпускай мышь близко к кружкам, но не точно
3. ✅ Snap работает
4. Двигай ноды — линии плавно движутся, не обрезаются, в центре кружков

## Логи которые подтвердят что архитектура работает

После накатки и одной генерации зайди в Vercel → Runtime Logs за момент:

**Хороший лог:**
```
[runs/start] handler invoked
[runs/start] created run xxx
[runs/start] after() started for run xxx
[executeRun] xxx starting
[executeRun] xxx executeGraph returned
[executeRun] xxx marked done
[runs/start] after() finished for run xxx
```

**Плохой лог (если новая транзакция падает):**
```
[executor] failed to persist node outputs into workflow.graph: <ошибка>
```
→ если увидишь — пришли мне строки с этим текстом, поправлю.

## Что НЕ изменилось (riskи минимальны)

- ❌ Никаких миграций БД (`workflow.graph` поле уже было JSON, просто туда теперь пишут с двух сторон)
- ❌ Никаких новых dependencies
- ❌ Никаких изменений в fal.ai / runners / API контрактах
- ❌ Никаких изменений в схеме Prisma
- ✅ Полная обратная совместимость со старыми workflows

## Технические заметки

### Гонка клиент↔сервер при autosave
Возможный сценарий: клиент видит outputs={A}, сервер пишет outputs={A,B} (другая нода завершилась). Клиент двигает ноду → autosave с outputs={A} → перетёр B.

**Когда это произойдёт:**
- Polling клиента (каждые 4с) не успел подхватить B
- Окно: ~200ms (debounce) после move ноды И ~4с (polling) после server-persist
- В худшем случае B потеряется на 4 секунды — следующий polling восстановит

**Когда это НЕ произойдёт (главный кейс):**
- Refresh / закрытие вкладки / переход в другой workflow → клиентский autosave не работает → server-persist канонический ✅

Это тот edge case с которым можно жить. Если будет проблема — refactor на разделение `Workflow.graph` (positions/configs) от `Workflow.outputs` (отдельное JSON поле). Но это уже миграция БД, не делаю превентивно.

### Атомарность server-persist
Executor запускает ноды одной depth-layer параллельно через `Promise.all`. Если два step'а заканчиваются одновременно — без транзакции:
1. Step A читает graph (без B.outputs)
2. Step B читает graph (без A.outputs)
3. Step A пишет с A.outputs → graph имеет A
4. Step B пишет с B.outputs → graph имеет B, **A потерян**

С `prisma.$transaction` Postgres серилизует — second transaction блокируется пока первая не commit'нется, и read во второй транзакции увидит свежий graph.

### Открытый вопрос: storage 24h
Этот патч **не закрывает** последний 🟡 — fal.ai URLs живут ~24ч. Через сутки картинки покажут broken image. Чтобы это починить нужно работающее Supabase Storage. После накатки этого патча сделай 1 генерацию и пришли Vercel logs с `[persistAsset]` — добью storage коротким патчем.
