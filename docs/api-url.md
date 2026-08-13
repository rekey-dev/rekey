# Which URL do I point the SDK at?

Every Rekey SDK needs one value before it can do anything: the origin of the
API it should talk to. It is called `apiUrl` in code and `REKEY_URL` in the
environment, and **there is no default** — you have to say.

## The answer

| You are… | `REKEY_URL` |
| --- | --- |
| on **Rekey Cloud** (you signed up at [rekey.dev](https://rekey.dev)) | `https://api.rekey.dev` |
| **self-hosting** | your own deployment's public origin, e.g. `https://api.yourcompany.com` |
| running locally | `http://localhost:3030` |

That is the whole answer. The rest of this page is why it works that way and
how to check you got it right.

## Why there is no default

A default would have to be `https://api.rekey.dev`, and for a self-hosted
deployment that is the wrong answer in the worst possible way: a missing
environment variable would not fail, it would send your `REKEY_SECRET` — a live
credential — in an `Authorization` header to a host you never chose. The
request fails there, because your key is unknown at Rekey Cloud, but the
credential has already left your infrastructure and the only symptom is a
puzzling 401.

So every SDK refuses to construct a client without the value, and the error
names both answers. `@rekey.dev/astro` briefly had that fallback and no longer
does.

The same rule removed the Rekey-owned defaults from the panel and the published
API docs: a self-hosted deployment's own `/docs` page used to list
`https://api.rekey.dev` as a server, so "Try it out" sent whatever key the
operator pasted to a host they had not chosen. It now lists that deployment's
own `API_URL` and nothing else.

(The rule is about what a self-hoster runs. Rekey Cloud's own internal services
point at Rekey-owned hosts on purpose — they are not part of this distribution.)

## Rekey Cloud is one API for everyone

There is no per-customer hostname. `https://api.rekey.dev` serves every Cloud
workspace, and requests are scoped by the **API key** you send, not by the URL.
Your key identifies your Application; two customers calling the same origin
never see each other's data.

Practically: if you signed up at rekey.dev, the URL is the same for you as for
everyone else, and the secret is the only thing that has to stay secret.

## Which key goes with it

`REKEY_URL` is only half the pair. Both come from **Panel → Application → API
Keys**:

| Variable | Value | Where it may run |
| --- | --- | --- |
| `REKEY_SECRET` | `rp_…` secret key | **Server only.** Never ship it to a browser. |
| `NEXT_PUBLIC_REKEY_PUBLIC_KEY` / publishable key | `rp_pub_…` | Browser. Public by design. |

Browser-side SDK entry points read a public spelling of the URL too —
`NEXT_PUBLIC_REKEY_URL` for `@rekey.dev/nextjs`. It is the same origin; the
prefix only tells the bundler it is safe to inline.

## Checking it

The API answers an unauthenticated health probe, so you can verify the origin
before wiring any keys:

```bash
curl -s https://api.rekey.dev/health/live
```

`/health/live` is the cheap liveness ping and answers `200` from any reachable
Rekey deployment. Swap in your own origin when self-hosting.

`/health` is the fuller check and reports the datastores:

```json
{"status":"ok","service":"rekey-api","db":"ok","redis":"ok"}
```

Read it for what it is: a **`200` with `service: "rekey-api"` means the origin is
right.** It does not have to say `ok` — a deployment whose Redis is down answers
`503` with `status: "degraded"`, and `redis` is three-valued (`ok`,
`unreachable`, `not_configured`). That is a health problem at a correct origin,
not a wrong URL. What tells you the URL is wrong is a connection failure, or a
`200` from something that is not Rekey.

If the origin is right and calls still fail, the error tells you which half is
at fault: `API_KEY_INVALID` means the URL reached a Rekey deployment and the
key was not recognised **there** — the usual cause is a key from one deployment
pointed at another (see [errors.md](errors.md)).

## Self-hosting: the URL the *providers* see

`REKEY_URL` is how *your code* reaches Rekey. It is not necessarily how a
payment provider reaches it.

The API builds provider webhook URLs from `PUBLIC_WEBHOOK_BASE_URL`, falling
back to `API_URL` when it is unset — so it is optional, and you only need it
when the two differ. They differ whenever `API_URL` is a private or in-cluster
hostname, because Stripe and PayPal call the webhook from the public internet
and cannot resolve it.

You find out you needed it at the point of use rather than at boot: registering
a webhook against a non-public base answers `BILLING_WEBHOOK_BASE_NOT_PUBLIC`,
which Panel → Application → Billing surfaces when you click Auto-configure.
