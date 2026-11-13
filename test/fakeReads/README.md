# Fake router read handlers

One module per feature. Each exports:

```ts
import type { FakeReadHandler } from '../fakeRouter';
export const handle: FakeReadHandler = (object, method, args, router) => { ... };
```

Return the recorded response (from `test/fixtures/ubus/...`) or `undefined`
when the call is not yours. `test/fakeRouter.ts` loads every `*.ts` here with
`import.meta.glob`, so adding a feature never touches the shared router.
Handlers only see calls the built-in switch does not answer.
