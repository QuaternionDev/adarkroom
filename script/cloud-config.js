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
  apiKey: '',
  authDomain: '',
  projectId: '',
  appId: '',
  providers: []
};
