-- Migration: Ajouter description_fr et description_en à document_types
-- Ces colonnes contiennent les phrases explicatives affichées dans l'app
-- pour expliquer la nécessité de chaque document dans les démarches administratives en Israël.

ALTER TABLE document_types
  ADD COLUMN IF NOT EXISTS description_fr TEXT,
  ADD COLUMN IF NOT EXISTS description_en TEXT;

-- Teoudat Zehout / Carte d'identité
UPDATE document_types SET
  description_fr = 'La Teoudat Zehout est votre carte d''identité israélienne. Document essentiel pour toutes vos démarches en Israël.',
  description_en = 'The Teoudat Zehout is your Israeli ID card. Essential document for all your procedures in Israel.'
WHERE slug IN ('teoudat_zehout', 'carte_d_identite');

-- Sefah
UPDATE document_types SET
  description_fr = 'Le Sefah (dépliant bleu) est un document médical important délivré par Kupat Holim, nécessaire pour certaines procédures de santé.',
  description_en = 'The Sefah (blue leaflet) is an important medical document issued by Kupat Holim, required for certain health procedures.'
WHERE slug = 'sefah';

-- Teoudat Olé
UPDATE document_types SET
  description_fr = 'La Teoudat Olé est votre certificat d''immigrant. Elle vous donne accès à des avantages spéciaux pendant vos premières années en Israël.',
  description_en = 'The Teoudat Olé is your immigrant certificate. It gives you access to special benefits during your first years in Israel.'
WHERE slug = 'teoudat_ole';

-- Passeport
UPDATE document_types SET
  description_fr = 'Votre passeport est indispensable pour voyager et certaines démarches administratives. Pensez à vérifier sa date d''expiration.',
  description_en = 'Your passport is essential for travel and certain administrative procedures. Remember to check its expiration date.'
WHERE slug IN ('passport', 'passeport', 'passeport_israelien', 'passeport_francais');

-- Carte Koupat Holim
UPDATE document_types SET
  description_fr = 'Votre carte Koupat Holim vous permet d''accéder aux soins médicaux en Israël. C''est votre carte d''assurance santé obligatoire.',
  description_en = 'Your Kupat Holim card allows you to access medical care in Israel. It is your mandatory health insurance card.'
WHERE slug IN ('carte_koupat_holim', 'koupat_holim');

-- Permis de conduire
UPDATE document_types SET
  description_fr = 'Votre permis de conduire est nécessaire pour conduire en Israël et pour certaines démarches (location de voiture, etc.).',
  description_en = 'Your driving license is necessary to drive in Israel and for certain procedures (car rental, etc.).'
WHERE slug IN ('permis_de_conduire', 'driving_license');

-- Carte grise
UPDATE document_types SET
  description_fr = 'La carte grise (Rishion Rechev) est le certificat d''immatriculation de votre véhicule. Document obligatoire pour circuler.',
  description_en = 'The vehicle registration (Rishion Rechev) is your vehicle''s registration certificate. Mandatory document to drive.'
WHERE slug = 'carte_grise';

-- Contrat de location
UPDATE document_types SET
  description_fr = 'Votre contrat de location est nécessaire pour de nombreuses démarches administratives (arnona, internet, etc.).',
  description_en = 'Your rental contract is necessary for many administrative procedures (arnona, internet, etc.).'
WHERE slug IN ('contrat_location', 'contrat_de_location');

-- Facture d'électricité
UPDATE document_types SET
  description_fr = 'Vos factures et relevés d''électricité. Utiles pour les changements d''abonnement ou réclamations.',
  description_en = 'Your electricity bills and statements. Useful for subscription changes or claims.'
WHERE slug IN ('facture_electricite', 'facture_electricité');

-- Facture de gaz
UPDATE document_types SET
  description_fr = 'Vos factures et documents relatifs au gaz. Conservez-les pour les changements de titulaire ou réclamations.',
  description_en = 'Your gas bills and documents. Keep them for account holder changes or claims.'
WHERE slug = 'facture_gaz';

-- Facture d'eau
UPDATE document_types SET
  description_fr = 'Vos factures d''eau sont nécessaires pour les démarches de changement de titulaire ou de réclamation.',
  description_en = 'Your water bills are necessary for account holder changes or claims.'
WHERE slug IN ('facture_eau', 'facture_d_eau');

-- Facture de téléphone
UPDATE document_types SET
  description_fr = 'Vos factures de téléphone et internet. Nécessaires pour les changements d''opérateur ou réclamations.',
  description_en = 'Your phone and internet bills. Necessary for operator changes or claims.'
WHERE slug IN ('facture_telephone', 'facture_téléphone');

-- Facture d'Arnona
UPDATE document_types SET
  description_fr = 'Vos factures d''arnona (taxe municipale). Important de les conserver pour les paiements et réclamations.',
  description_en = 'Your arnona bills (municipal tax). Important to keep for payments and claims.'
WHERE slug = 'facture_arnona';

-- Compteur d'eau
UPDATE document_types SET
  description_fr = 'Photos de votre compteur d''eau, nécessaires pour les changements de titulaire ou vérifications.',
  description_en = 'Photos of your water meter, necessary for account holder changes or verifications.'
WHERE slug = 'compteur_eau';

-- Compteur d'électricité
UPDATE document_types SET
  description_fr = 'Photos de votre compteur d''électricité, nécessaires pour les ouvertures de compte ou vérifications.',
  description_en = 'Photos of your electricity meter, necessary for account setup or verifications.'
WHERE slug IN ('compteur_electricite', 'compteur_electricité');

-- Compteur de gaz
UPDATE document_types SET
  description_fr = 'Photos de votre compteur de gaz, nécessaires pour les ouvertures de compte ou vérifications.',
  description_en = 'Photos of your gas meter, necessary for account setup or verifications.'
WHERE slug = 'compteur_gaz';

-- Assurance habitation / maison
UPDATE document_types SET
  description_fr = 'Votre assurance habitation protège votre logement. Nécessaire pour le contrat de location et les démarches immobilières.',
  description_en = 'Your home insurance protects your housing. Required for the rental contract and real estate procedures.'
WHERE slug IN ('assurance_habitation', 'assurance_maison');

-- Assurance automobile / voiture
UPDATE document_types SET
  description_fr = 'Votre assurance automobile est obligatoire en Israël. Indispensable pour circuler et en cas de contrôle.',
  description_en = 'Your car insurance is mandatory in Israel. Essential for driving and in case of inspection.'
WHERE slug IN ('assurance_automobile', 'assurance_voiture');

-- Assurance vie
UPDATE document_types SET
  description_fr = 'Votre assurance vie protège vos proches. Document important à conserver pour vos démarches financières.',
  description_en = 'Your life insurance protects your loved ones. Important document to keep for your financial procedures.'
WHERE slug = 'assurance_vie';

-- Assurance santé
UPDATE document_types SET
  description_fr = 'Votre assurance santé complémentaire couvre les frais non pris en charge par la Koupat Holim.',
  description_en = 'Your supplementary health insurance covers expenses not covered by Kupat Holim.'
WHERE slug = 'assurance_sante';

-- Assurance voyage
UPDATE document_types SET
  description_fr = 'Votre assurance voyage vous couvre lors de vos déplacements à l''étranger. Pensez à vérifier les dates de validité.',
  description_en = 'Your travel insurance covers you during trips abroad. Remember to check the validity dates.'
WHERE slug = 'assurance_voyage';

-- Fiche de paie
UPDATE document_types SET
  description_fr = 'Vos fiches de paie sont nécessaires pour de nombreuses démarches (prêt bancaire, impôts, Bitouah Leumi, location). Conservez-les précieusement.',
  description_en = 'Your payslips are necessary for many procedures (bank loan, taxes, Bitouah Leumi, rental). Keep them carefully.'
WHERE slug IN ('fiche_de_paie', 'fiche_paie');

-- Contrat de travail
UPDATE document_types SET
  description_fr = 'Votre contrat de travail définit vos droits et obligations. Nécessaire pour le Bitouah Leumi et les démarches bancaires.',
  description_en = 'Your employment contract defines your rights and obligations. Required for Bitouah Leumi and banking procedures.'
WHERE slug IN ('contrat_de_travail', 'contrat_travail');

-- Attestation de travail
UPDATE document_types SET
  description_fr = 'Votre attestation de travail confirme votre emploi actuel. Nécessaire pour les démarches bancaires et administratives.',
  description_en = 'Your employment certificate confirms your current job. Required for banking and administrative procedures.'
WHERE slug IN ('attestation_de_travail', 'attestation_travail');

-- Carte de crédit
UPDATE document_types SET
  description_fr = 'Votre carte de crédit est nécessaire pour certaines démarches de paiement et vérifications d''identité.',
  description_en = 'Your credit card is needed for certain payment procedures and identity verifications.'
WHERE slug = 'carte_credit';

-- Photo de profil
UPDATE document_types SET
  description_fr = 'Votre photo de profil est utilisée pour vos documents d''identité et démarches administratives.',
  description_en = 'Your profile photo is used for your identity documents and administrative procedures.'
WHERE slug = 'profile_photo';

-- Document médical
UPDATE document_types SET
  description_fr = 'Vos documents médicaux sont importants pour le suivi de votre santé et les démarches auprès de votre Koupat Holim.',
  description_en = 'Your medical documents are important for monitoring your health and procedures with your Kupat Holim.'
WHERE slug = 'document_medical';

-- Diplôme
UPDATE document_types SET
  description_fr = 'Vos diplômes doivent être traduits et certifiés pour être reconnus en Israël. Nécessaire pour la recherche d''emploi.',
  description_en = 'Your diplomas must be translated and certified to be recognized in Israel. Required for job searching.'
WHERE slug = 'diplome';

-- Justificatif de revenus
UPDATE document_types SET
  description_fr = 'Vos justificatifs de revenus sont nécessaires pour les démarches bancaires, fiscales et de location.',
  description_en = 'Your income proof documents are necessary for banking, tax, and rental procedures.'
WHERE slug = 'justificatif_revenus';

-- Acte de naissance
UPDATE document_types SET
  description_fr = 'Votre acte de naissance est nécessaire pour de nombreuses démarches officielles en Israël (mariage, inscription, etc.).',
  description_en = 'Your birth certificate is necessary for many official procedures in Israel (marriage, registration, etc.).'
WHERE slug = 'acte_de_naissance';

-- Ordonnance
UPDATE document_types SET
  description_fr = 'Vos ordonnances médicales sont nécessaires pour obtenir vos médicaments et pour le remboursement par votre Koupat Holim.',
  description_en = 'Your medical prescriptions are necessary to get your medications and for reimbursement by your Kupat Holim.'
WHERE slug = 'ordonnance';

-- Autre
UPDATE document_types SET
  description_fr = 'Tout autre document administratif ou personnel que vous souhaitez conserver en sécurité.',
  description_en = 'Any other administrative or personal document you wish to keep safe.'
WHERE slug = 'autre';

-- Fallback : remplir les descriptions manquantes avec un texte générique
UPDATE document_types SET
  description_fr = 'Document utile pour vos démarches administratives en Israël. Conservez-le précieusement.'
WHERE description_fr IS NULL;

UPDATE document_types SET
  description_en = 'Useful document for your administrative procedures in Israel. Keep it safely.'
WHERE description_en IS NULL;
