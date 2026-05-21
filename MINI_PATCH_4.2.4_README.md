# FlowLab Step 4.2.4 mini-patch — THE final fix

## Что произошло

Step 4.2.3 (Prisma + pgBouncer fix) **полностью убрал 500 ошибки** — это видно в логах: все 200 OK, никаких prepared statement конфликтов. Огромный прогресс.

Но генерации всё равно не происходят. **Почему?**

## Корень оставшейся проблемы

В `/api/runs/start` использовался паттерн **fire-and-forget**:

```ts
void executeRun(...).catch(err => console.error(err));
return NextResponse.json({ runId });
```

На Vercel serverless это **не работает надёжно**. Когда лямбда возвращает HTTP-ответ — Vercel **прибивает функцию мгновенно**, не дожидаясь фоновых промисов. Результат:
- ✅ `POST /api/runs/start` возвращает 200 + runId
- ❌ `executeRun` начинает работать → лямбда умирает → fal.ai никогда не вызывается
- 🔁 polling видит status=running вечно → UI крутит спиннер

В логах **нет** ни одного `[executeRun]` console.log — именно потому что код **не запускался**.

## Фикс

Использую **`after()` из Next.js 15** — это специальный API, который явно говорит Vercel: "удерживай функцию живой пока эта работа не завершится". У нас maxDuration=300s, так что 5 минут выполнения после ответа клиенту.

Также добавлены **детальные `console.log`** на каждый шаг executor — теперь в логах будет видна траектория каждого run.

## Файл (1 штука)

- `src/app/api/runs/start/route.ts`

## Накатить

GitHub веб → найди файл `src/app/api/runs/start/route.ts` → карандашик → стереть содержимое → вставить из этого архива → Commit `Use after() for background executor on Vercel`.

Или Upload files → перетащи `src/` целиком.

## После деплоя

1. Cmd+Shift+R
2. F12 → Console → ▶ на ноде
3. **Через 10-30 сек** для текстовой / **30-90 сек** для image → результат должен **появиться внутри ноды**

Если опять не работает — открой Vercel → Logs → фильтр `executeRun` или `runs/start`. Теперь там будут **подробные строки** с траекторией:

```
[runs/start] handler invoked
[runs/start] created run xxx, scope=n_yyy, nodes=2
[runs/start] after() started for run xxx
[executeRun] xxx starting; scope=n_yyy
[executeRun] xxx executeGraph returned; errors=0, cost=0.002
[executeRun] xxx marked done
[runs/start] after() finished for run xxx
```

Если в логах **обрывается на каком-то шаге** — знаем где сломалось. Скинь сами строки.

