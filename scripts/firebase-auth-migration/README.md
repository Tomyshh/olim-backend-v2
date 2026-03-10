# Migration Firebase Auth → Supabase Auth (avec mots de passe)

Script intégré au backend. **Firebase et Firestore ne sont pas modifiés.**

## Prérequis

- Firebase CLI (`firebase login` + `firebase use` ou `--project`)
- `supabase-service.json` avec le mot de passe DB
- `hash-parameters.md` avec les paramètres Firebase SCRYPT

## Configuration

1. **supabase-service.json** : remplir le champ `password` (mot de passe DB Supabase)
   - Si le mot de passe contient `@` ou d'autres caractères spéciaux, utiliser `password_base64` à la place :
     ```bash
     node -e "console.log('base64:'+Buffer.from('VOTRE_MOT_DE_PASSE','utf8').toString('base64'))"
     ```
     Puis mettre le résultat dans `"password_base64": "base64:XXXX"`

2. **hash-parameters.md** : doit contenir `base64_signer_key`, `base64_salt_separator`, `rounds`, `mem_cost` (Firebase Console → Authentication → Users → ⋮ → Password hash parameters)

## Exécution

```bash
npm run script:firebase-auth-to-supabase
```

Le script :
1. Supprime tous les utilisateurs Supabase Auth
2. Exporte les utilisateurs Firebase via `firebase auth:export` (inclut passwordHash + salt)
3. Importe dans Supabase avec le format `$fbscrypt$` (mots de passe conservés)

## Dépannage

**Connexion échoue (Internal Server Error ou Invalid credentials) avec $fbscrypt$ :**

Les paramètres de hash (`base64_signer_key`, `base64_salt_separator`) doivent être **exactement** ceux de votre projet Firebase. Vérifiez dans Firebase Console → Authentication → Users → ⋮ → Password hash parameters.

**Workaround** : si le format $fbscrypt$ pose problème, vous pouvez réinitialiser le mot de passe d’un utilisateur via l’API admin (bcrypt) :

```bash
npm run script:fix-user-password-supabase -- tomyyapp@gmail.com Aa123456
```

**Test de connexion :**

```bash
npm run script:test-supabase-login -- tomyyapp@gmail.com Aa123456
```

## Référence

- [Doc Supabase](https://supabase.com/docs/guides/platform/migrating-to-supabase/firebase-auth)
- [Supabase Auth PR #1768](https://github.com/supabase/auth/pull/1768) — support Firebase SCRYPT
