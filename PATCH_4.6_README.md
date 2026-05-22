# 🎯 Step 4.6 — Survive Refresh + Snap + Edge Centering + No Clipping

Это патч который чинит сразу 4 вещи:

| # | Баг | Как фиксится |
|---|-----|--------------|
| 🔴 1 | После refresh пропадают все картинки/видео | Autosave перестаёт выкидывать `outputs`/`results` |
| 🔴 2 | Линии-коннекторы обрезаются в области канваса | `overflow="visible"` на SVG |
| 🟡 3 | Edges не точно в центре кружков | Измеряем реальные DOM-позиции портов |
| 🟢 4 | Сложно попасть коннектором в кружок | Snap на 35px радиусе |

## ⚡ Накатить

В архиве лежит **один файл** — `src/components/canvas/CanvasEdges.tsx`. Он чинит баги #2 и #3 целиком.

Для багов #1 и #4 нужно сделать **две точечные правки в `src/components/canvas/Canvas.tsx` прямо через GitHub Web UI** (открыть файл → нажать ✏️ Edit). Так безопаснее чем перезаливать весь Canvas.tsx (879 строк, не хочется случайно сломать).

---

## Шаг 1 — Залить CanvasEdges.tsx

1. GitHub → твой репо `flowlab` → `src/components/canvas/`
2. **Add file → Upload files**
3. Перетащи `CanvasEdges.tsx` из распакованной папки этого архива
4. Внизу — Commit message: `Step 4.6: edge rendering — measure ports + overflow visible`
5. **Commit changes**

⚠️ GitHub спросит "Replace existing file?" → **Yes**.

---

## Шаг 2 — Правка #1 в Canvas.tsx (выживание outputs после refresh)

1. Открой `src/components/canvas/Canvas.tsx` в GitHub
2. Нажми ✏️ (Edit this file) — иконка карандаша справа сверху над файлом
3. Жми **Cmd+F** (или Ctrl+F) → в поисковой строке вставь:
   ```
   // Strip runtime state before saving
   ```
4. Ты увидишь блок:
   ```ts
       try {
         // Strip runtime state before saving
         const cleaned: Graph = {
           nodes: graph.nodes.map((n) => ({
             id: n.id,
             type: n.type,
             position: n.position,
             config: n.config,
           })),
           edges: graph.edges,
         };
         await saveWorkflowGraph(workflowId, cleaned);
   ```
5. **Замени** этот блок (от `// Strip runtime state` до `await saveWorkflowGraph...`) на:
   ```ts
       try {
         // Keep generated outputs/results in the saved snapshot so they survive
         // a page refresh. Without this, every reload wipes all generated images,
         // videos and text from the canvas (the files themselves still live in
         // Supabase Storage, but the node→URL mapping is lost). Status/error are
         // intentionally NOT persisted — they're volatile runtime state.
         const cleaned: Graph = {
           nodes: graph.nodes.map((n) => ({
             id: n.id,
             type: n.type,
             position: n.position,
             config: n.config,
             outputs: n.outputs,
             results: n.results,
           })),
           edges: graph.edges,
         };
         await saveWorkflowGraph(workflowId, cleaned);
   ```

6. Внизу страницы: Commit message → `Step 4.6 fix #1: persist generated outputs across refresh` → **Commit changes**

✅ Если всё ок — после следующей генерации картинка/видео переживёт refresh.

---

## Шаг 3 — Правка #2 в Canvas.tsx (snap к ближайшему порту)

1. Снова открой `Canvas.tsx`, нажми ✏️
2. **Cmd+F** → вставь в поиск:
   ```
   // Check if released over an input port
   ```
3. Ты увидишь блок:
   ```ts
         if (edgeDraft) {
           // Check if released over an input port via document.elementFromPoint
           const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
           const portEl = target?.closest?.("[data-port-side]");
           if (portEl?.getAttribute("data-port-side") === "in") {
             // input port handler will catch it via pointerup
           } else {
             // Open ConnectionPicker
             const pt = screenToCanvas(e.clientX, e.clientY);
             setConnPicker({
               screenX: e.clientX,
               screenY: e.clientY,
               canvasX: pt.x,
               canvasY: pt.y,
               fromNode: edgeDraft.fromNode,
               fromPort: edgeDraft.fromPort,
               fromKind: edgeDraft.fromKind,
             });
             setEdgeDraft(null);
             return;
           }
           setEdgeDraft(null);
         }
   ```

4. **Замени** этот блок целиком (от `if (edgeDraft) {` до закрывающей `}`) на:
   ```ts
         if (edgeDraft) {
           // 1. Direct hit on an input port — let the port's own pointerup handler take it.
           const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
           const portEl = target?.closest?.("[data-port-side]");
           if (portEl?.getAttribute("data-port-side") === "in") {
             setEdgeDraft(null);
             return;
           }

           // 2. SNAP: find the nearest input port within 35px and connect to it.
           // 14px circles are tiny — being lenient here makes connection feel much better.
           const SNAP_RADIUS_PX = 35;
           let bestNodeId: string | null = null;
           let bestPortId: string | null = null;
           let bestPortKind: string | null = null;
           let bestDist = SNAP_RADIUS_PX;
           document.querySelectorAll<HTMLElement>('[data-port-side="in"]').forEach((el) => {
             const nodeEl = el.closest<HTMLElement>("[data-node-id]");
             const nodeId = nodeEl?.getAttribute("data-node-id");
             const portId = el.getAttribute("data-port-id");
             const kind = el.getAttribute("data-port-kind");
             if (!nodeId || !portId || !kind) return;
             if (nodeId === edgeDraft.fromNode) return; // can't connect to self
             const r = el.getBoundingClientRect();
             const dx = (r.left + r.width / 2) - e.clientX;
             const dy = (r.top + r.height / 2) - e.clientY;
             const dist = Math.hypot(dx, dy);
             if (dist < bestDist) {
               bestDist = dist;
               bestNodeId = nodeId;
               bestPortId = portId;
               bestPortKind = kind;
             }
           });

           if (
             bestNodeId &&
             bestPortId &&
             bestPortKind &&
             portsCompatible(edgeDraft.fromKind, bestPortKind as never)
           ) {
             const snappedNodeId = bestNodeId;
             const snappedPortId = bestPortId;
             setGraph((g) => ({
               ...g,
               edges: [
                 ...g.edges.filter((e2) => !(e2.to.nodeId === snappedNodeId && e2.to.port === snappedPortId)),
                 makeEdge(edgeDraft.fromNode, edgeDraft.fromPort, snappedNodeId, snappedPortId),
               ],
             }));
             setEdgeDraft(null);
             return;
           }

           // 3. No port nearby — fall back to ConnectionPicker (pick a new node from menu).
           const pt = screenToCanvas(e.clientX, e.clientY);
           setConnPicker({
             screenX: e.clientX,
             screenY: e.clientY,
             canvasX: pt.x,
             canvasY: pt.y,
             fromNode: edgeDraft.fromNode,
             fromPort: edgeDraft.fromPort,
             fromKind: edgeDraft.fromKind,
           });
           setEdgeDraft(null);
         }
   ```

5. Commit message → `Step 4.6 fix #2: snap edges to nearest input port within 35px` → **Commit changes**

---

## Шаг 4 — (опциональная) Правка #3 в Canvas.tsx

Без этой правки всё работает, но если ты часто меняешь zoom — edges могут на секунду «съезжать» пока не подвигаешь ноду. С правкой — мгновенно перепозиционируются.

1. Открой `Canvas.tsx`, нажми ✏️
2. **Cmd+F** → вставь в поиск:
   ```
   <CanvasEdges
   ```
3. Ты увидишь рендер компонента, например:
   ```tsx
   <CanvasEdges
     graph={graph}
     hoveredEdgeId={hoveredEdge}
     draftEdge={edgeDraft ? {...} : null}
     liveDragNodeId={drag?.nodeId ?? null}
     liveDragPos={liveDragPos.current}
     onHover={setHoveredEdge}
     onDelete={deleteEdge}
   />
   ```
4. **Добавь** в этот компонент два новых пропа — `pan={pan}` и `zoom={zoom}` — например после `liveDragPos`:
   ```tsx
   <CanvasEdges
     graph={graph}
     hoveredEdgeId={hoveredEdge}
     draftEdge={edgeDraft ? {...} : null}
     liveDragNodeId={drag?.nodeId ?? null}
     liveDragPos={liveDragPos.current}
     pan={pan}
     zoom={zoom}
     onHover={setHoveredEdge}
     onDelete={deleteEdge}
   />
   ```
5. Commit message → `Step 4.6 fix #3: pass pan/zoom to edges for accurate remeasure` → **Commit changes**

---

## Шаг 5 — Дождись Vercel build (Ready)

После каждого коммита Vercel автоматически передеплоит. После последнего — открывай прод.

## Шаг 6 — Тест

**Cmd+Shift+R** (hard refresh).

### Тест #1 — survive refresh (главный тест!)
1. Запусти любую ноду (например Image Generation с Nano Banana 2) → дождись картинки
2. **F5** или закрой вкладку → открой заново
3. ✅ Картинка должна быть на месте

Если не сработает — пришли мне Vercel logs за момент сохранения, проверим `saveWorkflowGraph` (но скорее всего сразу заработает).

### Тест #2 — линии не обрезаются
1. Создай несколько нод в разных местах канваса, соедини их
2. Полазь по канвасу — pan, zoom
3. ✅ Линии всегда видны целиком, никаких обрезаний

### Тест #3 — edges точно в центре
1. Запзумься до 200% (Cmd+scroll много раз)
2. ✅ Линии входят строго в центр кружков

### Тест #4 — snap работает
1. Тяни линию от output port одной ноды к input port другой
2. Отпусти кнопку мыши **близко к кружку, но не строго в него** (например, на 20-30px от центра)
3. ✅ Линия автоматически прицепится к ближайшему совместимому порту

Если отпустить далеко (>35px) — откроется привычное ConnectionPicker меню как сейчас.

---

## Что НЕ меняется

- ❌ Никаких изменений в fal.ai / executor / БД / Supabase Storage
- ❌ Никаких новых API
- ❌ Никаких dependencies
- ✅ Только клиентский рендеринг канваса

То есть **никакого риска для существующих воркфлоу и потраченных fal.ai кредитов**.

---

## Открытый вопрос: картинки в Supabase

Главный 🟡 пункт из Step 4.5 («fal.ai URLs живут ~24ч → нужно работающее Supabase Storage») этот патч **не закрывает** — он только спасает мета-данные (привязку node→URL) от refresh. Но если fal URL уже умер через сутки — твоя нода будет показывать broken image.

Поэтому, после того как этот патч задеплоится и протестируется:
- **Сделай 1 генерацию** на проде
- Открой Vercel → Project → Logs (Runtime) за этот момент
- Поищи строки `[persistAsset] STORAGE FAILED` или `[persistAsset] saved`
- Скинь мне 5-10 строк вокруг неё — добью storage в следующем коротком патче

Если в логах видно `STORAGE FAILED` с осмысленной причиной (например `bucket not found`) — заранее зайди в Supabase Dashboard → Storage → создай bucket `flowlab-assets` (Private).
