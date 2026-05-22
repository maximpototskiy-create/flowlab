# 🚨 Step 4.8.1 — Consolidated fix (4.7 + 4.8 merged)

## Что произошло

**Моя ошибка**: когда я собирал 4.8 zip, я взял исходный архив проекта (до 4.7), применил только 4.8-правки и упаковал. Когда ты накатил 4.8 — мой `Canvas.tsx` **перетёр** твою рабочую 4.7-версию.

Сейчас на GitHub:
- ✅ `page.tsx` — версия 4.7 (передаёт `initialActiveRun` в Canvas)
- ❌ `Canvas.tsx` — версия 4.8 БЕЗ 4.7 (не имеет `initialActiveRun` в props)

→ TypeScript падает на билде: "Property 'initialActiveRun' does not exist".

## Что в этом патче

**12 файлов**, объединённое состояние 4.7 + 4.8:

```
4.7 files (статусы генераций):
├── src/app/api/runs/active/route.ts            🆕
├── src/app/projects/[id]/workflows/[wid]/page.tsx
├── src/components/ActiveRunsIndicator.tsx      🆕
├── src/components/TopNav.tsx
├── src/components/canvas/CanvasToolbar.tsx
└── src/components/canvas/OtherActiveRunsBadge.tsx 🆕

4.8 files (multimodal + aspect bug):
├── src/lib/canvas/types.ts
├── src/lib/engine/executor.ts
├── src/lib/engine/runners.ts
├── src/lib/fal/client.ts
└── src/components/canvas/CanvasNode.tsx

4.7 + 4.8 merged:
└── src/components/canvas/Canvas.tsx            ← ВАЖНО: содержит ОБОИ наборы правок
```

## Как накатить

1. Распакуй `flowlab-step4.8.1-consolidated-fix.zip`
2. GitHub → Upload files → перетащи папку `src`
3. GitHub скажет: **"12 files will be updated/added"** (или меньше если что-то совпадает)
4. Commit: `Step 4.8.1: consolidate 4.7 + 4.8 — fix Canvas.tsx merge`
5. **Commit changes**
6. Vercel build пройдёт чисто (проверил локально через tsc — 0 ошибок)

## Что работает после накатки

| Из 4.7 (status visibility): | Из 4.8 (multimodal + aspect): |
|---|---|
| ✅ Бейдж в TopNav при активных runs | ✅ Aspect 9:16 работает для Nano Banana (был баг) |
| ✅ Resume статусов на нодах при возврате | ✅ Multi-port "images" для Nano Banana (до 14 рефов) |
| ✅ "N elsewhere" в CanvasToolbar | ✅ Multi-image для Vision LLM (Claude/GPT/Gemini) |
| ✅ Server-side persistence outputs | ✅ Kling V3 aspect — серый + tooltip |

## Type-check verification

Локально прогнал `npx tsc --noEmit` на **всех 12 файлах** — 0 ошибок. Билд должен пройти.

## Извинения

Извини за overhead. Корневая причина — я не учёл что 4.7 + 4.8 трогают **один и тот же** `Canvas.tsx` и собрал 4.8 в отрыве от твоего рабочего состояния. На будущее буду собирать каждый патч **только** из последнего залитого тобой состояния проекта.
