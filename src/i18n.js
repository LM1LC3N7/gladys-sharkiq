// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, buttons, command refusals,
// feature names, the error of a robot), in English and French.
// -----------------------------------------------------------------------------

/** The text of `texts` in `language`, English otherwise. */
export const word = (texts, language) => texts[language] ?? texts.en;

const both = (en, fr) => ({ en, fr });

/** Two messages one after the other, in each language. */
export const join = (...messages) =>
  both(messages.map((m) => m.en).join(' '), messages.map((m) => m.fr).join(' '));

/** "25 min" / "3 h", for the pauses. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 120) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const DEVICE_NAME = both('Shark robot', 'Robot Shark');

/** Feature names, in the language chosen in the configuration. */
export const FEATURE_NAMES = {
  state: both('State', 'État'),
  battery: both('Battery', 'Batterie'),
  suction: both('Suction power', "Puissance d'aspiration"),
  error: both('Error', 'Erreur'),
  start: both('Start cleaning', 'Démarrer le nettoyage'),
  pause: both('Pause', 'Pause'),
  stop: both('Stop', 'Arrêter'),
  dock: both('Return to the dock', 'Retour à la base'),
  locate: both('Locate (beep)', 'Localiser (bip)'),
};

/** The labels of the suction power options. */
export const SUCTION_LABELS = {
  eco: both('Eco', 'Éco'),
  normal: both('Normal', 'Normal'),
  max: both('Max', 'Max'),
};

/** sharkiq ERROR_MESSAGES, translated. */
const ERRORS = {
  1: both('Side wheel is stuck', 'Roue latérale bloquée'),
  2: both('Side brush is stuck', 'Brosse latérale bloquée'),
  3: both('Suction motor failed', "Moteur d'aspiration en panne"),
  4: both('Brushroll stuck', 'Brosse rotative bloquée'),
  5: both('Side wheel is stuck (2)', 'Roue latérale bloquée (2)'),
  6: both('Bumper is stuck', 'Pare-chocs bloqué'),
  7: both('Cliff sensor is blocked', 'Capteur de vide obstrué'),
  8: both('Battery power is low', 'Batterie faible'),
  9: both('No dustbin', 'Bac à poussière absent'),
  10: both('Fall sensor is blocked', 'Capteur de chute obstrué'),
  11: both('Front wheel is stuck', 'Roue avant bloquée'),
  13: both('Switched off', 'Éteint'),
  14: both('Magnetic strip error', 'Erreur de bande magnétique'),
  16: both('Top bumper is stuck', 'Pare-chocs supérieur bloqué'),
  18: both('Wheel encoder error', 'Erreur du codeur de roue'),
  40: both('Dustbin is blocked', 'Bac à poussière bouché'),
};

/** The error of a robot as a text: "None", "Brushroll stuck (4)", "Unknown error (99)". */
export function errorText(code) {
  if (code === 0) {
    return both('No error', 'Aucune erreur');
  }
  const known = ERRORS[code];
  if (known) {
    return both(`${known.en} (${code})`, `${known.fr} (${code})`);
  }
  return both(`Unknown error (${code})`, `Erreur inconnue (${code})`);
}

const robots = (n) => both(`${n} robot${n > 1 ? 's' : ''}`, `${n} robot${n > 1 ? 's' : ''}`);

const SIGN_IN_HINT = both(
  'click "Sign in to Shark" in the configuration',
  'cliquez sur « Se connecter à Shark » dans la configuration',
);

export const T = {
  noCredentials: both(
    'Enter the e-mail and the password of your Shark account (the ones of the SharkClean app) and choose its region, then save.',
    "Saisissez l'e-mail et le mot de passe de votre compte Shark (ceux de l'application SharkClean) et choisissez sa région, puis enregistrez.",
  ),
  connecting: both('Signing in to Shark…', 'Connexion à Shark…'),
  connected: (read, total) => {
    const missing = total - read;
    const lost =
      missing > 0
        ? both(
            ` ${missing} robot${missing > 1 ? 's' : ''} could not be read (see ${missing > 1 ? 'their' : 'its'} badge).`,
            ` ${missing} robot${missing > 1 ? 's' : ''} n'${missing > 1 ? 'ont' : 'a'} pas pu être lu${missing > 1 ? 's' : ''} (voir ${missing > 1 ? 'leur' : 'son'} badge).`,
          )
        : both('', '');
    const count = robots(total);
    return both(
      `Connected to Shark: ${count.en}. Open Discovery to add ${total > 1 ? 'them' : 'it'}.${lost.en}`,
      `Connecté à Shark : ${count.fr}. Ouvrez Découverte pour ${total > 1 ? 'les ' : "l'"}ajouter.${lost.fr}`,
    );
  },
  noRobot: both(
    'Connected to Shark, but the account has no robot.',
    "Connecté à Shark, mais le compte n'a aucun robot.",
  ),
  refused: both(
    `Shark refused the e-mail or the password (or the region). The integration never tries again by itself (each try counts against the account lockout): check them, save, or ${SIGN_IN_HINT.en}.`,
    `Shark a refusé l'e-mail ou le mot de passe (ou la région). L'intégration ne réessaie jamais d'elle-même (chaque essai compte pour le blocage du compte) : vérifiez-les, enregistrez, ou ${SIGN_IN_HINT.fr}.`,
  ),
  verification: both(
    `Shark asks for a verification (a code, or a check against robots), which this integration does not handle. It never signs in again by itself: sign in once in the SharkClean app, then ${SIGN_IN_HINT.en}.`,
    `Shark demande une vérification (un code, ou un contrôle anti-robot), que cette intégration ne gère pas. Elle ne se reconnecte jamais d'elle-même : connectez-vous une fois dans l'application SharkClean, puis ${SIGN_IN_HINT.fr}.`,
  ),
  locked: both(
    `Shark blocked the account after too many sign-in attempts. Unblock it (e-mail from SharkNinja, or the SharkClean app), then ${SIGN_IN_HINT.en}.`,
    `Shark a bloqué le compte après trop d'essais de connexion. Débloquez-le (e-mail de SharkNinja, ou l'application SharkClean), puis ${SIGN_IN_HINT.fr}.`,
  ),
  unsupported: (detail) =>
    both(
      `Shark answered the sign-in in a way this integration does not know${detail ? ` (${detail})` : ''}. It never tries again by itself: ${SIGN_IN_HINT.en}.`,
      `Shark a répondu à la connexion d'une façon que cette intégration ne connaît pas${detail ? ` (${detail})` : ''}. Elle ne réessaie jamais d'elle-même : ${SIGN_IN_HINT.fr}.`,
    ),
  interrupted: both(
    `The sign-in to Shark was interrupted (no answer, a server error or too many requests) after the password was sent. The integration never sends it again by itself: ${SIGN_IN_HINT.en}.`,
    `La connexion à Shark a été interrompue (pas de réponse, erreur serveur ou trop de requêtes) après l'envoi du mot de passe. L'intégration ne le renvoie jamais d'elle-même : ${SIGN_IN_HINT.fr}.`,
  ),
  incomplete: both(
    `Shark accepted the password, but the sign-in did not finish (the next step failed). This is not a refused password. The integration never signs in again by itself: ${SIGN_IN_HINT.en}.`,
    `Shark a accepté le mot de passe, mais la connexion est inachevée (l'étape suivante a échoué). Ce n'est pas un mot de passe refusé. L'intégration ne se reconnecte jamais d'elle-même : ${SIGN_IN_HINT.fr}.`,
  ),
  storeBroken: both(
    `The state of the integration in /data cannot be read or written (permissions, or a damaged file). It never signs in by itself then: ${SIGN_IN_HINT.en}.`,
    `L'état de l'intégration dans /data est illisible ou ne peut pas être écrit (droits, ou fichier abîmé). Elle ne se connecte alors jamais d'elle-même : ${SIGN_IN_HINT.fr}.`,
  ),
  sessionExpired: both(
    `The Shark session expired. The integration never signs in again with the password by itself: ${SIGN_IN_HINT.en}.`,
    `La session Shark a expiré. L'intégration ne se reconnecte jamais d'elle-même avec le mot de passe : ${SIGN_IN_HINT.fr}.`,
  ),
  unreachable: (reason, wait) =>
    both(
      `Shark cannot be reached (${reason.en}). Next try in ${wait.en}.`,
      `Shark est injoignable (${reason.fr}). Nouvel essai dans ${wait.fr}.`,
    ),
  rateLimited: (wait) =>
    both(
      `Shark asks to slow down: pausing for ${wait.en}.`,
      `Shark demande de ralentir : pause de ${wait.fr}.`,
    ),
  unavailable: (wait) =>
    both(
      `The Shark cloud is unavailable (server error): pausing for ${wait.en}.`,
      `Le cloud Shark est indisponible (erreur serveur) : pause de ${wait.fr}.`,
    ),
  offline: both(
    'The Shark cloud says this robot is offline (Wi-Fi, power, or switched off).',
    'Le cloud Shark indique que ce robot est hors ligne (Wi-Fi, alimentation, ou éteint).',
  ),
  robotNoAnswer: both(
    'Shark did not answer for this robot at the last read (an error or a timeout of the cloud).',
    "Shark n'a pas répondu pour ce robot à la dernière lecture (erreur ou délai dépassé du cloud).",
  ),
  robotUnreadable: both(
    'This robot could not be read (no longer in the account, or a bad answer).',
    "Ce robot n'a pas pu être lu (absent du compte, ou réponse invalide).",
  ),
  busy: both(
    'A read of Shark is in progress: try again in a minute.',
    'Une lecture de Shark est en cours : réessayez dans une minute.',
  ),
  cooldown: both('Already read less than 30 seconds ago.', 'Déjà lu il y a moins de 30 secondes.'),
  test: {
    noSession: both(
      `Not signed in to Shark yet: ${SIGN_IN_HINT.en} (this button never uses the password).`,
      `Pas encore connecté à Shark : ${SIGN_IN_HINT.fr} (ce bouton n'utilise jamais le mot de passe).`,
    ),
  },
  denied: {
    noConfig: both('The Shark account is not configured.', "Le compte Shark n'est pas configuré."),
    stopped: both(
      'The Shark account is not connected (see the status of the integration): command refused, nothing sent.',
      "Le compte Shark n'est pas connecté (voir l'état de l'intégration) : commande refusée, rien n'a été envoyé.",
    ),
    paused: both(
      'Shark asked to slow down: command refused during the pause, nothing sent.',
      "Shark a demandé de ralentir : commande refusée pendant la pause, rien n'a été envoyé.",
    ),
    badButton: both(
      'Unexpected value: this button only accepts 1.',
      "Valeur inattendue : ce bouton n'accepte que 1.",
    ),
    badSuction: both(
      'Unexpected suction power: Eco, Normal or Max only.',
      "Puissance d'aspiration inattendue : Éco, Normal ou Max seulement.",
    ),
    session: both(
      'The Shark session is being renewed: command refused, nothing sent. Try again in a few seconds.',
      "La session Shark est en cours de renouvellement : commande refusée, rien n'a été envoyé. Réessayez dans quelques secondes.",
    ),
    unknownDevice: both(
      'This robot is not (or no longer) in the Shark account.',
      "Ce robot n'est pas (ou plus) dans le compte Shark.",
    ),
    unreadable: both(
      'The state of the robot could not be read again just before acting: command refused, nothing sent.',
      "L'état du robot n'a pas pu être relu juste avant d'agir : commande refusée, rien n'a été envoyé.",
    ),
    unknown: both(
      'The robot did not report its operating mode: command refused, nothing sent.',
      "Le robot n'a pas indiqué son mode de fonctionnement : commande refusée, rien n'a été envoyé.",
    ),
    stopMeanwhile: both(
      'A stop, a pause or a return to the dock of this robot was asked meanwhile: start refused, nothing sent.',
      "Un arrêt, une pause ou un retour à la base de ce robot a été demandé entre-temps : démarrage refusé, rien n'a été envoyé.",
    ),
    late: both(
      'Shark answered too late: command refused before acting (nothing was sent).',
      "Shark a répondu trop tard : commande refusée avant d'agir (rien n'a été envoyé).",
    ),
  },
  maybeSent: (reason) =>
    both(
      `The command was sent, without a confirmation from Shark (${reason.en}). Check the state of the robot.`,
      `La commande a été envoyée, sans confirmation de Shark (${reason.fr}). Vérifiez l'état du robot.`,
    ),
  commandFailed: (reason) =>
    both(
      `Shark refused the command (${reason.en}): nothing was done.`,
      `Shark a refusé la commande (${reason.fr}) : rien n'a été fait.`,
    ),
  signIn: {
    noCredentials: both(
      'Enter and save the e-mail and the password first.',
      "Saisissez et enregistrez d'abord l'e-mail et le mot de passe.",
    ),
  },
};

/** The reason of an error, by kind, in both languages (never an English text in French). */
const REASONS = {
  network: both('network error', 'erreur réseau'),
  timeout: both('no answer in time', 'pas de réponse à temps'),
  unavailable: both('Shark unavailable', 'Shark indisponible'),
  bad_response: both('unexpected answer', 'réponse inattendue'),
  size: both('answer too large', 'réponse trop grande'),
  not_found: both('not found', 'introuvable'),
  forbidden: both('refused', 'refusé'),
  rate_limited: both('too many requests', 'trop de requêtes'),
  unauthorized: both('session refused', 'session refusée'),
  session_expired: both('session expired', 'session expirée'),
  http: both('request failed', 'requête en échec'),
};

/** `{ en, fr }`: the reason of an error, with its HTTP status when there is one. */
export function reasonOf(err) {
  const reason = REASONS[err?.kind] ?? both('error', 'erreur');
  const status = Number.isInteger(err?.status) ? `, HTTP ${err.status}` : '';
  return both(`${reason.en}${status}`, `${reason.fr}${status}`);
}
