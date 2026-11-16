# Valo Shop

Appli Windows pour Valorant :

- **Boutique** : offres du jour, marché nocturne, et le contenu complet des packs.
- **Collection** : tous tes skins par arme (possédés, équipés), avec changement de skin et de variante depuis l'appli.
- **En jeu** :
  - rangs, stats et skins des joueurs de ta partie ;
  - tes stats récentes, avec le détail de chaque partie (tableau des scores, rounds, duels) ;
  - choix du mode et lancement de la recherche.
- **Plusieurs comptes** Riot.

## Télécharger

👉 **[Dernière version](https://github.com/Robert229919/valo-shop/releases/latest)**

- `ValoShop-Setup.exe` : installe l'appli avec un raccourci sur le Bureau et dans le menu Démarrer. **Elle se met à jour toute seule.**
- `ValoShop-portable.exe` : se lance sans installation, mais n'a pas de mise à jour automatique.

Au premier lancement, Windows SmartScreen peut afficher « Windows a protégé votre ordinateur », parce que l'exe n'est pas signé. Clique sur **Informations complémentaires**, puis **Exécuter quand même**.

## Connexion

Clique sur « Se connecter avec Riot » : la page officielle de Riot s'ouvre dans une fenêtre, et l'appli ne voit jamais ton mot de passe. Coche « Rester connecté » pour ne pas avoir à te reconnecter. Tes sessions restent sur ton PC (`%APPDATA%\valo-shop-viewer`).

## Développement

```bash
npm install
npm run app      # lance l'appli (Electron)
npm start        # version navigateur seule : http://localhost:5173
npm run dist     # construit les .exe dans dist/
```

Pour publier une nouvelle version :

1. Augmente `version` dans `package.json`.
2. Lance `npm run dist`.
3. Crée une release GitHub `vX.Y.Z` avec `ValoShop-Setup.exe`, `ValoShop-Setup.exe.blockmap`, `latest.yml` et `ValoShop-portable.exe`.

Les applis installées se mettent alors à jour toutes seules.

## Avertissement et limitation de responsabilité

Ce projet est **non officiel** et **n'est ni affilié, ni approuvé, ni sponsorisé par Riot Games**. VALORANT et Riot Games sont des marques de Riot Games, Inc.

L'appli utilise les **API internes, non documentées**, du client Riot, comme d'autres applis du même genre. Riot peut les modifier ou les bloquer à tout moment, et leur usage par des outils tiers **peut être contraire aux conditions d'utilisation de Riot**.

**Tu l'utilises à tes propres risques.** L'auteur de ce projet et ses contributeurs :

- **ne sont pas responsables** des sanctions, suspensions, bannissements (temporaires ou définitifs), restrictions, pertes de rang, d'objets ou de données qu'un compte pourrait subir, de près ou de loin, à cause de l'utilisation de cette appli ;
- **ne garantissent rien** : le logiciel est fourni « tel quel », sans garantie d'aucune sorte, et peut cesser de fonctionner à tout moment ;
- **se désolidarisent entièrement** de tout usage qui contreviendrait aux règles de Riot ou à celles du jeu, et de toute conséquence qui en découlerait.

Certaines fonctions **agissent sur ton compte** (changer de skin équipé, choisir le mode, lancer la recherche, choisir et verrouiller un agent). Ce sont elles qui présentent le plus de risques : n'active que ce dont tu acceptes les conséquences.

Ton mot de passe n'est jamais lu ni enregistré par l'appli (la connexion passe par la page officielle de Riot) et aucune donnée n'est envoyée à l'auteur.
