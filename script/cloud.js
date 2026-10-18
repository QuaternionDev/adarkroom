(function() {

  /**
   * Cloud saves: syncs the game state to a per-user Firestore document so a
   * save follows the player across devices.
   *
   * - saves/{uid}   the live save: { state, revision, updatedAt, device }
   * - backups/{uid} the save most recently replaced (by a push, a load, or a
   *                 restore), so a bad sync can be undone once
   *
   * The Firebase SDK is only loaded once the player has opened the cloud menu
   * (or signed in on an earlier visit), so the base game has no dependency on
   * it. Everything here is best-effort: if the cloud is unreachable the game
   * keeps saving to localStorage as usual.
   */

  var SDK_BASE = 'https://www.gstatic.com/firebasejs/10.14.1/';
  var SDK_FILES = [
    'firebase-app-compat.js',
    'firebase-auth-compat.js',
    'firebase-firestore-compat.js'
  ];

  // Every popup-based Firebase provider. Each one only works if it is also
  // enabled in the Firebase console; CloudConfig.providers can narrow the list shown.
  var PROVIDERS = {
    google: function() { return new firebase.auth.GoogleAuthProvider(); },
    github: function() { return new firebase.auth.GithubAuthProvider(); },
    microsoft: function() { return new firebase.auth.OAuthProvider('microsoft.com'); },
    apple: function() { return new firebase.auth.OAuthProvider('apple.com'); },
    facebook: function() { return new firebase.auth.FacebookAuthProvider(); },
    twitter: function() { return new firebase.auth.TwitterAuthProvider(); },
    yahoo: function() { return new firebase.auth.OAuthProvider('yahoo.com'); }
  };

  var Cloud = window.Cloud = {

    SYNC_DELAY: 30 * 1000,
    CHECK_THROTTLE: 60 * 1000,
    // a save still matching the last sync this soon after load is untouched by the player
    STARTUP_WINDOW: 20 * 1000,

    META_KEY: 'cloudMeta',
    DEVICE_KEY: 'cloudDevice',

    user: null,
    _timer: null,
    _syncing: false,
    _blocked: false,
    _reloading: false,
    _firstCheck: true,
    _lastCheck: 0,
    _dialogPending: false,

    isConfigured: function() {
      return !!(window.CloudConfig && CloudConfig.apiKey && CloudConfig.projectId);
    },

    // Call once the menu is built and State is loaded, before the modules start ticking
    init: function() {
      Cloud._initAt = Date.now();
      Cloud._startupHash = Cloud._hash(JSON.stringify(window.State));

      document.addEventListener('visibilitychange', function() {
        if(!Cloud.user) return;
        if(document.visibilityState == 'hidden') {
          Cloud.sync('auto');
        } else if(Date.now() - Cloud._lastCheck > Cloud.CHECK_THROTTLE) {
          Cloud.sync('check');
        }
      });

      if(Cloud._readMeta().enabled) {
        Cloud._loadSdk().then(Cloud._watchAuth).catch(function(e) {
          Engine.log('cloud: ' + e);
        });
      }
    },

    // Hooked into Engine.saveGame, which runs on nearly every state change
    onLocalSave: function() {
      if(!Cloud.user || Cloud._timer || Cloud._blocked || Cloud._reloading) return;
      Cloud._timer = setTimeout(function() {
        Cloud._timer = null;
        Cloud.sync('auto');
      }, Cloud.SYNC_DELAY);
    },

    /**
     * Sync
     */

    // mode: 'auto' pushes quietly, 'check' also looks for a newer cloud save, 'manual' reports back
    sync: function(mode) {
      mode = mode || 'auto';
      if(!Cloud.user || Cloud._syncing || Cloud._reloading) return Promise.resolve();
      if(mode == 'manual') {
        Cloud._blocked = false;
      } else if(Cloud._blocked) {
        return Promise.resolve();
      }
      clearTimeout(Cloud._timer);
      Cloud._timer = null;
      Cloud._syncing = true;
      return Cloud._sync(mode).catch(function(e) {
        Engine.log('cloud sync failed: ' + e);
        if(mode == 'manual') Cloud._say(_('could not reach the cloud.'));
      }).then(function() {
        Cloud._syncing = false;
      });
    },

    _sync: async function(mode) {
      var meta = Cloud._readMeta();
      var local = JSON.stringify(window.State);
      var startupClean = Cloud._firstCheck &&
        Date.now() - Cloud._initAt < Cloud.STARTUP_WINDOW &&
        Cloud._startupHash === meta.hash;
      var dirty = !startupClean && Cloud._hash(local) !== meta.hash;

      if(mode == 'auto') {
        if(!dirty) return;
        if(meta.revision != null) {
          // skip the read; the transaction notices if the cloud moved on
          try {
            await Cloud._push(local, meta.revision);
            return;
          } catch(e) {
            if(!e.stale) throw e;
          }
        }
      }

      var remote = await Cloud._fetch('saves');
      Cloud._firstCheck = false;
      Cloud._lastCheck = Date.now();

      if(!remote) {
        await Cloud._push(local, 0);
        if(mode == 'manual') Cloud._say(_('saved to the cloud.'));
        return;
      }
      if(remote.revision === meta.revision) {
        if(dirty) {
          await Cloud._push(local, remote.revision);
          if(mode == 'manual') Cloud._say(_('saved to the cloud.'));
        } else if(mode == 'manual') {
          Cloud._say(_('already up to date.'));
        }
        return;
      }

      // the cloud holds something this device hasn't seen
      if(!dirty || Cloud._isFresh(local)) {
        await Cloud._applyRemote(remote.state, remote.revision, null);
        return;
      }
      Cloud._resolveDialog(
        meta.revision == null ?
          _('found a save in the cloud, but this device has progress too.') :
          _('this device and the cloud have both changed.'),
        local, remote
      );
    },

    _push: async function(local, expected) {
      var db = Cloud._db;
      var ref = db.collection('saves').doc(Cloud.user.uid);
      var backup = db.collection('backups').doc(Cloud.user.uid);
      var revision = await db.runTransaction(async function(tx) {
        var snap = await tx.get(ref);
        var current = snap.exists ? snap.data().revision : 0;
        if(current !== expected) {
          var stale = new Error('cloud save changed');
          stale.stale = true;
          throw stale;
        }
        if(snap.exists) tx.set(backup, snap.data());
        tx.set(ref, {
          state: local,
          revision: current + 1,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          device: Cloud._deviceId()
        });
        return current + 1;
      });
      Cloud._writeMeta({revision: revision, hash: Cloud._hash(local), syncedAt: Date.now()});
      return revision;
    },

    _fetch: async function(collection) {
      var snap = await Cloud._db.collection(collection).doc(Cloud.user.uid).get();
      return snap.exists ? snap.data() : null;
    },

    // Replace the local save and reload. stash, if given, is the state to keep as the backup.
    // pushOnLoad makes the next load treat the save as unsynced, so it gets pushed.
    _applyRemote: async function(state, revision, stash, pushOnLoad) {
      var parsed;
      try {
        parsed = JSON.parse(state);
      } catch(e) {
        Cloud._say(_('the cloud save is unreadable.'));
        return;
      }
      if(stash) {
        await Cloud._db.collection('backups').doc(Cloud.user.uid).set({
          state: stash,
          revision: revision,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          device: Cloud._deviceId()
        });
      }
      Cloud._reloading = true;
      clearTimeout(Cloud._timer);
      Cloud._writeMeta({
        revision: revision,
        hash: pushOnLoad ? null : Cloud._hash(state),
        syncedAt: Date.now()
      });
      localStorage.gameState = state;
      // a game tick can still save before the reload lands; make sure it saves this state
      window.State = parsed;
      location.reload();
    },

    /**
     * Dialogs
     */

    openMenu: function() {
      // start loading now so the sign-in click can open its popup without waiting
      Cloud._loadSdk().catch(function(e) {
        Engine.log('cloud: ' + e);
      });
      var meta = Cloud._readMeta();
      if(!Cloud.user) {
        var buttons = {};
        Cloud._providerNames().forEach(function(name) {
          buttons[name] = {
            text: _('sign in with {0}', name),
            nextScene: 'end',
            onChoose: function() { Cloud.signIn(name); }
          };
        });
        buttons.cancel = {
          text: _('cancel'),
          nextScene: 'end'
        };
        Events.startEvent({
          title: _('Cloud save'),
          scenes: {
            start: {
              text: [
                _('keep one save across every device.'),
                _('sign in to begin.')
              ],
              buttons: buttons
            }
          }
        });
        return;
      }

      var text = [
        _('signed in as {0}.', Cloud.user.email || Cloud.user.displayName || Cloud.user.uid),
        meta.syncedAt ?
          _('last synced: {0}', new Date(meta.syncedAt).toLocaleString()) :
          _('not synced yet.')
      ];
      if(Cloud._blocked) text.push(_('automatic sync is paused.'));
      Events.startEvent({
        title: _('Cloud save'),
        scenes: {
          start: {
            text: text,
            buttons: {
              'sync': {
                text: _('sync now'),
                nextScene: 'end',
                onChoose: function() { Cloud.sync('manual'); }
              },
              'restore': {
                text: _('restore backup'),
                nextScene: 'end',
                onChoose: Cloud.restoreBackup
              },
              'signout': {
                text: _('sign out'),
                nextScene: 'end',
                onChoose: Cloud.signOut
              },
              'cancel': {
                text: _('close'),
                nextScene: 'end'
              }
            }
          }
        }
      });
    },

    _resolveDialog: function(headline, local, remote) {
      if(Cloud._dialogPending) return;
      Cloud._dialogPending = true;
      var when = remote.updatedAt && remote.updatedAt.toMillis ?
        ' (' + new Date(remote.updatedAt.toMillis()).toLocaleString() + ')' : '';
      Cloud._whenIdle(function() {
        Cloud._dialogPending = false;
        Events.startEvent({
          title: _('Cloud save'),
          scenes: {
            start: {
              text: [
                headline,
                _('this device: {0}', Cloud._summary(local)),
                _('cloud: {0}', Cloud._summary(remote.state) + when),
                _('the save you do not pick is kept as a backup.')
              ],
              buttons: {
                'usecloud': {
                  text: _('use cloud save'),
                  nextScene: 'end',
                  onChoose: function() {
                    Cloud._applyRemote(remote.state, remote.revision, local).catch(function(e) {
                      Engine.log('cloud: ' + e);
                      Cloud._say(_('could not reach the cloud.'));
                    });
                  }
                },
                'usedevice': {
                  text: _('use this device'),
                  nextScene: 'end',
                  onChoose: function() {
                    Cloud._push(local, remote.revision).then(function() {
                      Cloud._say(_('saved to the cloud.'));
                    }).catch(function(e) {
                      Engine.log('cloud: ' + e);
                      Cloud._say(_('the cloud save changed again. try syncing once more.'));
                    });
                  }
                },
                'later': {
                  text: _('not now'),
                  nextScene: 'end',
                  onChoose: function() { Cloud._blocked = true; }
                }
              }
            }
          }
        });
      });
    },

    restoreBackup: async function() {
      try {
        var backup = await Cloud._fetch('backups');
        if(!backup) {
          Cloud._say(_('no backup yet.'));
          return;
        }
        var remote = await Cloud._fetch('saves');
        Cloud._whenIdle(function() {
          Events.startEvent({
            title: _('Restore backup'),
            scenes: {
              start: {
                text: [
                  _('backup: {0}', Cloud._summary(backup.state)),
                  _('this replaces the save on this device and in the cloud.')
                ],
                buttons: {
                  'restorebackup': {
                    text: _('restore'),
                    nextScene: 'end',
                    onChoose: function() {
                      Cloud._restore(backup, remote).catch(function(e) {
                        Engine.log('cloud: ' + e);
                        Cloud._say(_('could not reach the cloud.'));
                      });
                    }
                  },
                  'cancel': {
                    text: _('cancel'),
                    nextScene: 'end'
                  }
                }
              }
            }
          });
        });
      } catch(e) {
        Engine.log('cloud: ' + e);
        Cloud._say(_('could not reach the cloud.'));
      }
    },

    _restore: async function(backup, remote) {
      var revision = remote ? remote.revision : 0;
      // keep what is about to be replaced, so a restore can itself be undone
      var stash = remote ? remote.state : JSON.stringify(window.State);
      await Cloud._applyRemote(backup.state, revision, stash, true);
    },

    /**
     * Auth
     */

    signIn: async function(which) {
      if(!PROVIDERS[which]) return;
      try {
        await Cloud._loadSdk();
        Cloud._watchAuth();
        await Cloud._auth.signInWithPopup(PROVIDERS[which]());
      } catch(e) {
        Engine.log('cloud: ' + e);
        if(e.code == 'auth/account-exists-with-different-credential') {
          Cloud._say(_('that email already has an account. sign in with the provider you used first.'));
        } else if(e.code == 'auth/operation-not-allowed' || e.code == 'auth/configuration-not-found') {
          Cloud._say(_('{0} sign-in is not turned on for this game.', which));
        } else if(e.code == 'auth/unauthorized-domain') {
          Cloud._say(_('this site is not on the cloud save domain list.'));
        } else if(e.code != 'auth/popup-closed-by-user' && e.code != 'auth/cancelled-popup-request') {
          Cloud._say(_('could not sign in.'));
        }
      }
    },

    // CloudConfig.providers picks and orders the sign-in buttons; unset shows every known provider
    _providerNames: function() {
      var wanted = window.CloudConfig && CloudConfig.providers;
      var names = Object.keys(PROVIDERS);
      if(!wanted || !wanted.length) return names;
      return wanted.filter(function(name) { return PROVIDERS[name]; });
    },

    signOut: async function() {
      try {
        await Cloud._auth.signOut();
      } catch(e) {
        Engine.log('cloud: ' + e);
      }
      clearTimeout(Cloud._timer);
      Cloud._timer = null;
      Cloud._blocked = false;
      Cloud._writeMeta({enabled: false, uid: null, revision: null, hash: null, syncedAt: null});
      Cloud._say(_('signed out.'));
    },

    _watchAuth: function() {
      if(Cloud._watching) return;
      Cloud._watching = true;
      Cloud._auth.onAuthStateChanged(function(user) {
        Cloud.user = user;
        var meta = Cloud._readMeta();
        if(!user) {
          // a session that expired on its own; an explicit sign out already cleared this
          if(meta.enabled) {
            Cloud._writeMeta({enabled: false});
            Cloud._say(_('signed out of the cloud.'));
          }
          return;
        }
        if(meta.uid != user.uid) {
          // a different account has a different save history
          meta.revision = null;
          meta.hash = null;
          meta.syncedAt = null;
        }
        meta.enabled = true;
        meta.uid = user.uid;
        Cloud._writeMeta(meta);
        Cloud.sync('check');
      });
    },

    _loadSdk: function() {
      if(Cloud._sdk) return Cloud._sdk;
      var load = function(file) {
        return new Promise(function(resolve, reject) {
          var script = document.createElement('script');
          script.src = SDK_BASE + file;
          script.onload = resolve;
          script.onerror = function() { reject(new Error('could not load ' + file)); };
          document.head.appendChild(script);
        });
      };
      Cloud._sdk = load(SDK_FILES[0]).then(function() {
        return Promise.all(SDK_FILES.slice(1).map(load));
      }).then(function() {
        firebase.initializeApp(window.CloudConfig);
        Cloud._auth = firebase.auth();
        Cloud._db = firebase.firestore();
      }).catch(function(e) {
        Cloud._sdk = null;
        throw e;
      });
      return Cloud._sdk;
    },

    /**
     * Helpers
     */

    _say: function(text) {
      Notifications.notify(null, text);
    },

    // Events can't be stacked while one is fading out, so wait until none is active
    _whenIdle: function(fn) {
      if(Events.activeEvent() != null) {
        setTimeout(function() { Cloud._whenIdle(fn); }, 1000);
        return;
      }
      fn();
    },

    // Nothing worth losing: the builder hasn't shown up and no earlier run was finished
    _isFresh: function(local) {
      var s = JSON.parse(local);
      var builder = s.game && s.game.builder ? s.game.builder.level : undefined;
      return (builder === undefined || builder < 0) && !(s.previous && s.previous.score);
    },

    _summary: function(state) {
      var s;
      try {
        s = JSON.parse(state);
      } catch(e) {
        return _('unreadable');
      }
      var game = s.game || {};
      var parts = [];
      if(game.fire && game.fire.text) parts.push(_('fire: {0}', game.fire.text));
      if(game.population) parts.push(_('villagers: {0}', game.population));
      if(game.buildings && game.buildings.hut) parts.push(_('huts: {0}', game.buildings.hut));
      if(s.previous && s.previous.score) parts.push(_('previous score: {0}', s.previous.score));
      return parts.length ? parts.join(', ') : _('just started');
    },

    _hash: function(str) {
      var h = 5381;
      for(var i = 0; i < str.length; i++) {
        h = ((h << 5) + h + str.charCodeAt(i)) | 0;
      }
      return str.length + ':' + h;
    },

    _deviceId: function() {
      try {
        var id = localStorage[Cloud.DEVICE_KEY];
        if(!id) {
          id = Math.random().toString(36).slice(2, 10);
          localStorage[Cloud.DEVICE_KEY] = id;
        }
        return id;
      } catch(e) {
        return 'unknown';
      }
    },

    _readMeta: function() {
      try {
        return JSON.parse(localStorage[Cloud.META_KEY]) || {};
      } catch(e) {
        return {};
      }
    },

    _writeMeta: function(changes) {
      var meta = $.extend(Cloud._readMeta(), changes);
      try {
        localStorage[Cloud.META_KEY] = JSON.stringify(meta);
      } catch(e) {
        Engine.log('cloud: could not save sync info');
      }
    }
  };

})();
