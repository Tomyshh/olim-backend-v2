# Scripts manuels

Ce dossier contient les scripts utilitaires pour effectuer des opérations manuelles sur le backend.

## Scripts disponibles

### `link-phone-to-email.ts`

Lie un **numéro de téléphone** à un compte **email** (Firebase Auth), en gardant le compte email comme “original”.

Fonctionnement :
- Cherche l’utilisateur par email (compte à conserver).
- Cherche l’utilisateur par phoneNumber (compte “phone-only” à désactiver).
- Libère le numéro (retire le phoneNumber du compte téléphone si possible).
- Attache le numéro au compte email.
- Désactive le compte téléphone (si encore présent).

Sécurité :
- **Dry-run par défaut** (ne modifie rien).
- Ajoute `--apply` pour effectuer la fusion.

Exemple (dry-run) :
```bash
npm run script:link-phone-to-email -- --email leaderecoenergie@gmail.com --phone +972555002485
```

Exemple (apply) :
```bash
npm run script:link-phone-to-email -- --email leaderecoenergie@gmail.com --phone +972555002485 --apply
```

Si Firebase refuse de retirer le phoneNumber du compte téléphone (rare mais possible), tu peux forcer :
```bash
npm run script:link-phone-to-email -- --email leaderecoenergie@gmail.com --phone +972555002485 --apply --force-delete-phone-user
```

## Ajouter un nouveau script

1. Créer un nouveau fichier `.ts` dans ce dossier
2. Importer les utilitaires nécessaires :
   ```typescript
   import { initializeFirebase, getFirestore } from '../src/config/firebase.js';
   import dotenv from 'dotenv';
   dotenv.config();
   ```
3. Ajouter un script npm dans `package.json` :
   ```json
   "script:nom-du-script": "tsx scripts/nom-du-script.ts"
   ```

