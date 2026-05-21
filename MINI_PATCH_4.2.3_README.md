# FlowLab Step 4.2.3 mini-patch — FINAL FIX

## Что показали логи Vercel

```
prisma:error
Invalid `prisma.user.findUnique()` invocation:
ConnectorError ... code: "42P05", 
message: "prepared statement \"s5\" already exists"
```

Это **известный bug** Prisma + Supabase Transaction Pooler (порт 6543).
- Pooler **переиспользует** соединения между разными запросами
- Prisma **кеширует prepared statements** в каждой сессии  
- Когда два запроса попадают на одно соединение — имена `s0/s5/...` конфликтуют → ERROR

## Что фиксит этот патч

Переписан `src/lib/prisma.ts`:
- Автоматически добавляет в `DATABASE_URL` параметры `pgbouncer=true`, `connection_limit=1`, `statement_cache_size=0`
- Singleton через `globalThis` чтобы не плодить клиентов
- Можно не трогать env vars вообще — код сам корректирует URL

Также в `Canvas.tsx`:
- Polling 2 → 3 секунды (меньше нагрузка на БД, меньше шанс гонок)
- `cache: "no-store"` на polling запросах (всегда свежий ответ)

## Файлы (2 штуки)

- `src/lib/prisma.ts`
- `src/components/canvas/Canvas.tsx`

## Как накатить

GitHub → Upload files → перетащи папку `src` из архива → Commit `Fix Prisma + pgBouncer prepared statement conflict`.

Vercel автоматом передеплоит за 2-3 минуты.

## ВАЖНО — после деплоя

1. **Cmd+Shift+R** жёсткий рефреш браузера
2. F12 → Console
3. ▶ на ноде
4. Ожидаем:
   - `[FlowLab] startRun called`
   - `[FlowLab] sending POST /api/runs/start`
   - `[FlowLab] /api/runs/start responded 200`
   - **БЕЗ красных 500-ок**
   - Через 10-30 сек **результат генерации появляется внутри ноды**

Если опять `prepared statement` ошибки в Vercel Logs — значит нужно сменить порт в `DATABASE_URL` с **6543 → 5432** (session pooler вместо transaction pooler). Сделать в Vercel → Settings → Environment Variables → `DATABASE_URL` → поменять `:6543/` на `:5432/`.

