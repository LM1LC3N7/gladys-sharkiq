# Shark IQ

Intégration non officielle, sans lien avec SharkNinja. Elle amène dans Gladys
les **aspirateurs robots Shark** reliés à l'application **SharkClean**, par le
cloud Shark (le service de connexion de SharkNinja et Ayla Networks), celui
qu'utilise l'application.

> **Attention : API non officielle, cette intégration n'a jamais été testée
> avec un vrai robot ni un vrai compte.** Elle a été écrite à partir de la
> bibliothèque sharkiq et testée contre un faux cloud Shark seulement.
> SharkNinja peut changer son API à tout moment. Les retours sont les
> bienvenus.

## Ce que vous obtenez

Pour chaque robot du compte :

| Fonctionnalité         | Détail                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| État                   | Lecture seule : nettoyage, pause, retour à la base, en charge, à la base, arrêté, erreur. |
| Batterie               | En %.                                                                                     |
| Puissance d'aspiration | Liste : Éco, Normal, Max.                                                                 |
| Erreur                 | Texte, par exemple « Brosse rotative bloquée (4) » ou « Aucune erreur ».                  |
| Démarrer le nettoyage  | Bouton.                                                                                   |
| Pause                  | Bouton.                                                                                   |
| Arrêter                | Bouton.                                                                                   |
| Retour à la base       | Bouton.                                                                                   |
| Localiser (bip)        | Bouton : le robot émet un son.                                                            |

Le badge de chaque robot affiche « cloud », ou « injoignable » (avec un point
orange) quand le cloud indique le robot hors ligne ou qu'il ne peut pas être
lu.

## Installation

1. Vos robots doivent fonctionner dans l'application **SharkClean**.
2. Dans Gladys, installez l'intégration Shark IQ, choisissez la **région** du
   compte (Europe, ou Amérique du Nord), saisissez l'**e-mail** et le **mot de
   passe** de l'application SharkClean, et enregistrez.
3. Ajoutez les robots depuis l'onglet **Découverte**.

## Connexion : jamais sans votre clic

Le service de connexion de SharkNinja bloque un compte après plusieurs essais
refusés, et peut demander une vérification (un code, un contrôle anti-robot).
L'intégration n'envoie donc **le mot de passe qu'à votre demande** :

- une fois quand vous enregistrez l'e-mail et le mot de passe (ou au premier
  démarrage avec eux) ;
- ensuite, seulement quand vous cliquez sur **Se connecter à Shark**.

L'autorisation de connexion est consommée, et enregistrée dans `/data`,
**avant** l'envoi du mot de passe : si `/data` ne peut pas être écrit, rien
ne part. Seul un échec prouvé avant l'envoi (nom introuvable, connexion
impossible) est réessayé, deux fois au plus.

Un mot de passe refusé, une vérification demandée, un compte bloqué, une
connexion **interrompue** (pas de réponse, erreur serveur ou « trop de
requêtes » de SharkNinja après l'envoi du mot de passe), une connexion
**inachevée** (mot de passe accepté, mais l'étape suivante a échoué), un
état `/data` illisible ou une session expirée arrêtent l'intégration, et cet
arrêt est gardé aux redémarrages : elle ne réessaie jamais d'elle-même avec
le mot de passe. Après un mot de passe accepté, seul l'échange chez Ayla
(sans le mot de passe) est réessayé, trois fois au plus, espacées. Corrigez
ce qui est indiqué (dans l'application SharkClean si besoin), puis cliquez
sur **Se connecter à Shark**. **Tester la connexion** lit les robots avec la
session en cours et n'utilise jamais le mot de passe.

Entre-temps, la session (environ 24 heures) est renouvelée par un minuteur,
10 minutes avant sa fin (à mi-vie pour une session courte), avec le jeton de
rafraîchissement : sans le mot de passe, et jamais deux fois en moins d'une
minute.

## Mot de passe, jetons et vie privée

- Le mot de passe est **gardé par Gladys dans sa base, jamais réaffiché, et
  envoyé seulement au service de connexion de SharkNinja** (Auth0), dans les
  cas ci-dessus.
- Les jetons d'Ayla sont gardés dans le volume `/data` de l'intégration pour
  qu'un redémarrage ne se reconnecte pas. Sur l'hôte de Gladys, ce volume est
  le dossier `<dossier de base de Gladys>/external-integrations/<sélecteur>` :
  lisible par root et par l'uid 1000 (l'utilisateur du conteneur), absent des
  sauvegardes de Gladys, supprimé à la désinstallation. **Le jeton de
  rafraîchissement donne le contrôle des robots** tant qu'il est valable :
  protégez cet hôte. L'e-mail et le mot de passe n'y sont jamais écrits.
- Rien n'apparaît dans les journaux : ni mot de passe, ni jeton, ni e-mail, ni
  numéro de série complet (seulement ses 4 derniers caractères).
- Tout passe en HTTPS vers `logineu.sharkninja.com` (ou
  `login.sharkninja.com`), puis `user-field-eu.aylanetworks.com` et
  `ads-eu.aylanetworks.com` (ou `user-sharkue1` et `ads-sharkue1` en
  Amérique du Nord).

## Commandes

- **Aucun interrupteur** : l'état est en lecture seule et les commandes sont
  des boutons. Un « allume tout » ou un « éteins tout » d'une scène ou d'un
  assistant vocal ne démarre ni n'arrête jamais un robot.
- Démarrer, Pause, Retour à la base et la puissance d'aspiration **relisent
  le robot** dans le cloud juste avant d'agir : la commande est refusée si
  cette lecture échoue ou ne donne pas le mode du robot. « Déjà fait »
  n'envoie rien (un démarrage sur un robot qui nettoie, une pause sur un
  robot à la base), sauf si un autre ordre vient de partir (dans la minute) :
  le cloud peut encore montrer l'état d'avant.
- Arrêter et Localiser ne décident rien : ils partent sans relecture.
- Les commandes d'un même robot passent une à la fois. Arrêter n'attend
  jamais derrière elles, seulement derrière un démarrage déjà parti, pour
  arriver après lui. Un démarrage en attente est annulé si un arrêt, une
  pause ou un retour à la base arrive entre-temps.
- Une commande qui ne peut pas partir dans les **3,5 secondes** suivant son
  arrivée est refusée : Gladys affiche un échec au bout de 5 secondes, et
  rien ne part après cet échec.
- Si Shark ne confirme pas une commande partie, Gladys affiche « envoyée, sans
  confirmation » : vérifiez l'état du robot, relu dans les secondes qui
  suivent.

## Rafraîchissement et erreurs

- Les robots sont lus toutes les 60 secondes par défaut (30 à 900), une
  requête par robot, plus la liste du compte toutes les 10 minutes et trois
  lectures dans la minute qui suit une commande.
- **Shark demande de ralentir** (HTTP 429) : une pause d'au moins 1 minute
  (Retry-After s'il est donné, 6 h au plus), pour tous les chemins, commandes
  comprises, gardée aux redémarrages.
- **Erreur serveur** (5xx) : une pause de 1, 2, 5, 10 puis 15 minutes, jamais
  plus courte que l'intervalle, gardée aux redémarrages.
- **Réseau** : nouvel essai après 1, 2, 5, 10 puis toutes les 15 minutes.
- Un robot illisible (404, erreur) ne marque que lui ; les autres sont lus.

## Limites

- Jamais testée avec un vrai robot ni un vrai compte : les noms des
  propriétés, leurs valeurs et la connexion viennent de sharkiq 1.5.1.
- **Comptes européens** : la connexion est le « password grant » Auth0
  direct (e-mail et mot de passe envoyés en une requête). La détection de
  robots d'Auth0 (`requires_verification`, CAPTCHA) peut la refuser, sans
  contournement possible : l'intégration s'arrête alors (« vérification »).
  sharkiq a quitté ce flux aux États-Unis pour cette raison.
- La connexion nord-américaine passe par une page de consentement d'Auth0
  lue automatiquement : si SharkNinja la change, la connexion échoue (arrêt,
  sans nouvel essai).
- Pas de nettoyage par pièce, pas de carte, pas de serpillière pour
  l'instant.

## Crédits

- [sharkiq](https://github.com/sharkiqlibs/sharkiq) 1.5.1 (MIT) : la
  connexion, l'API Ayla, les propriétés et les commandes sont portées en
  JavaScript. Voir `THIRD_PARTY_NOTICES.md`.

Shark, Shark IQ et SharkClean sont des marques de SharkNinja ; ce projet est
sans lien avec SharkNinja.
