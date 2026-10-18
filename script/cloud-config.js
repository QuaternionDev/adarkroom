/**
 * Firebase web config for cloud saves. See doc/cloud-save.md for setup.
 *
 * These values are public by design (they ship to every browser that loads
 * the game). The Firestore security rules are what protect player data.
 *
 * While apiKey is empty the cloud menu button stays hidden and the game
 * behaves exactly like upstream.
 *
 * providers is optional. Leave it out to offer every supported sign-in
 * (google, github, microsoft, apple, facebook, twitter, yahoo). A provider
 * only works once it is enabled in Firebase Authentication; list just the
 * ones you enabled to hide the rest, e.g. ['google', 'github'].
 */
window.CloudConfig = {
  apiKey: 'AIzaSyB1t_cMIXZA_OT2ZJ-8bMQaiO17zNiH9sk',
  authDomain: 'adarkroom-clouds.firebaseapp.com',
  projectId: 'adarkroom-clouds',
  appId: '1:459856730360:web:a3fc64530560065aec030d',
  providers: ['google']
};
