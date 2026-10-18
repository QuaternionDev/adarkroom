# Cloud save

Syncs the game save to a Firestore document so progress follows you across devices. Sign in with Google or GitHub through Firebase Auth. Until `script/cloud-config.js` is filled in, the `cloud.` menu button is hidden and the game behaves as before.

## One-time setup

1. **Create a Firebase project** at https://console.firebase.google.com (the free Spark plan is plenty).
2. **Add a web app** (Project settings → Your apps → `</>`). Copy the `firebaseConfig` values into `script/cloud-config.js` (`apiKey`, `authDomain`, `projectId`, `appId`). These are public by design.
3. **Create the database**: Build → Firestore Database → Create database (production mode).
4. **Enable sign-in providers**: Build → Authentication → Sign-in method.
   - **Google**: enable it and pick a support email.
   - **GitHub**: enable it, then on GitHub go to Settings → Developer settings → OAuth Apps → New OAuth App. Set the *Authorization callback URL* to the one Firebase shows (`https://<project-id>.firebaseapp.com/__/auth/handler`), then paste the app's Client ID and secret back into Firebase.
   - **Others** (microsoft, apple, facebook, twitter, yahoo): the game supports them too, but each needs its own developer app and keys in the Firebase console. If a provider isn't enabled, players who click it see "sign-in is not turned on for this game". Set `providers` in `script/cloud-config.js` to the ones you enabled to hide the rest. Email/password, phone and anonymous sign-in aren't supported.
5. **Authorize your domain**: Authentication → Settings → Authorized domains → add the host the game is served from (e.g. `<username>.github.io`). `localhost` is already allowed.
6. **Publish the security rules** (Firestore → Rules):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{collection}/{uid} {
      allow read: if (collection == 'saves' || collection == 'backups')
                  && request.auth != null && request.auth.uid == uid;
      allow create, update: if (collection == 'saves' || collection == 'backups')
                  && request.auth != null && request.auth.uid == uid
                  && request.resource.data.keys().hasOnly(['state', 'revision', 'updatedAt', 'device'])
                  && request.resource.data.state is string
                  && request.resource.data.state.size() < 500000
                  && request.resource.data.revision is int
                  && request.resource.data.updatedAt is timestamp;
    }
  }
}
```

If you sign in with Google and later with GitHub using the same email, Firebase may refuse with "account exists with a different credential". Sign in with the provider you used first. (Authentication → Settings → User account linking controls this.)

## Running locally

`yarn start`, then open http://localhost:8080. Sign-in popups do not work from `file://`.

## How it behaves

- The save is pushed about 30 seconds after the last change, and whenever the tab is hidden.
- On load, and when you return to the tab, the cloud is checked. A newer cloud save is loaded automatically if this device has nothing newer; if both sides changed you are asked which to keep.
- Whichever save loses is kept as the single `backup`. `restore backup` in the cloud menu brings it back.
- Pushes are transactions on a revision number, so two devices playing at once can't silently overwrite each other.

## Data

| Path | Fields |
| --- | --- |
| `saves/{uid}` | `state` (the same JSON string stored in `localStorage.gameState`), `revision`, `updatedAt`, `device` |
| `backups/{uid}` | same shape; the save most recently replaced |

Per-device sync info lives in `localStorage.cloudMeta` and `localStorage.cloudDevice`, and survives `restart`.
