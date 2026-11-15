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

## Avertissement

L'appli utilise les API internes, non officielles, de Riot, comme VALpaw et les autres applis du même genre. Usage personnel. Riot peut changer ces API à tout moment. Projet non affilié à Riot Games.
