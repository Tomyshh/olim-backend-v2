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

---

### `list-system-registration-clients.ts`

**Description :** Script en LECTURE SEULE pour récupérer la liste des clients ayant des critères spécifiques dans leur subscription.

**Critères de recherche :**
- `modifiedBy`: "SYSTEM_REGISTRATION"
- `membership`: "Visitor"
- `startDate`: Entre le 14/12/2025 et le 22/12/2025 (modifiable dans le script)

**Utilisation :**
```bash
npm run script:list-system-registration
```

**Sortie :**
- Affichage console détaillé avec progression (analyse de tous les clients)
- Liste formatée des clients trouvés
- Export JSON inclus dans la sortie console

**⚠️ IMPORTANT :** Ce script est en LECTURE SEULE - aucune modification n'est effectuée dans la base de données.

**Résultats automatiquement sauvegardés :**
- `RESULTATS_CLIENTS_SYSTEM_REGISTRATION.md` - Rapport complet en Markdown
- `RESULTATS_CLIENTS_SYSTEM_REGISTRATION.json` - Données au format JSON
- `RESULTATS_CLIENTS_SYSTEM_REGISTRATION.csv` - Données au format CSV pour Excel

**Personnalisation :**
Pour modifier les critères de recherche, éditez le fichier `list-system-registration-clients.ts` :
- Ligne ~39 : Modifier les dates `startDateMin` et `startDateMax`
- Ligne ~70 : Modifier les critères de filtrage (`hasSystemRegistration`, `isVisitor`, etc.)

---

### `upsert-membership-details.ts`

**Description :** Ajoute / met à jour **uniquement** le document `Utils/membership_details` avec la liste des détails des packs (FR + EN).

Sécurité :
- **Dry-run par défaut** (ne modifie rien).
- Ajoute `--apply` pour écrire en base.
- Utilise `set(..., { merge: true })` (ne supprime pas les autres champs éventuels du document).

Utilisation (dry-run) :
```bash
npm run script:upsert-membership-details
```

Utilisation (apply) :
```bash
npm run script:upsert-membership-details -- --apply
```

---

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

