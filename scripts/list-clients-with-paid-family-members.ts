import { getFirestore, initializeFirebase } from '../src/config/firebase.js';

type Args = {
  json: boolean;
  includeInferred: boolean;
  limit: number; // 0 = unlimited
};

type PaidMemberRow = {
  clientUid: string;
  clientEmail: string | null;
  clientFirstName: string | null;
  clientLastName: string | null;
  memberId: string;
  memberFirstName: string | null;
  memberLastName: string | null;
  relationship: string | null;
  serviceActivationPaymentId: string | null;
  selectedCardId: string | null;
  inferredPaid: boolean;
};

function pickString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function pickBool(value: unknown, fallback = false): boolean {
  if (value === true) return true;
  if (value === false) return false;
  return fallback;
}

function parseArgs(argv: string[]): Args {
  let json = false;
  let includeInferred = false;
  let limit = 0;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    if (a === '--include-inferred') includeInferred = true;
    if (a === '--limit') {
      const n = Number(String(argv[i + 1] || '').trim());
      if (Number.isFinite(n) && n > 0) limit = Math.floor(n);
    }
  }

  return { json, includeInferred, limit };
}

function isConjoint(status: unknown): boolean {
  return pickString(status).toLowerCase() === 'conjoint';
}

function isPaidMemberByStrongEvidence(data: Record<string, unknown>): boolean {
  // Preuve forte: un paiement one-shot a été enregistré
  return pickString(data.serviceActivationPaymentId).length > 0;
}

function isPaidMemberByInference(data: Record<string, unknown>): boolean {
  // Fallback utile pour anciens documents incomplets
  const status = pickString(data['Family Member Status'] ?? data.familyMemberStatus);
  const serviceActive = pickBool(data.serviceActive, false);
  const billingExempt = pickBool(data.billingExempt, false);
  const selectedCardId = pickString(data.selectedCardId);
  const isPaidAdultChild = pickBool(data.isPaidAdultChild, false);
  const monthlySupplementApplied = pickBool(data.monthlySupplementApplied, false);

  if (billingExempt) return false;
  if (isConjoint(status)) return false;
  if (!serviceActive) return false;

  // Signaux compatibles avec un membre payant même si paymentId absent.
  return !!selectedCardId || isPaidAdultChild || monthlySupplementApplied;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log('[list-clients-with-paid-family-members] LECTURE SEULE');
  console.log('[list-clients-with-paid-family-members] Options', {
    includeInferred: args.includeInferred,
    limit: args.limit || null,
    json: args.json
  });

  initializeFirebase();
  const db = getFirestore();

  const clientsSnap = await db.collection('Clients').get();
  console.log('[list-clients-with-paid-family-members] Clients trouvés:', clientsSnap.size);

  const rows: PaidMemberRow[] = [];
  let checked = 0;

  for (const clientDoc of clientsSnap.docs) {
    checked++;
    if (checked % 200 === 0) {
      console.log(`[progress] ${checked}/${clientsSnap.size} clients analysés...`);
    }

    const clientUid = clientDoc.id;
    const c = (clientDoc.data() || {}) as Record<string, unknown>;

    const membersSnap = await db.collection('Clients').doc(clientUid).collection('Family Members').get();
    if (membersSnap.empty) continue;

    for (const memberDoc of membersSnap.docs) {
      const m = (memberDoc.data() || {}) as Record<string, unknown>;

      const strong = isPaidMemberByStrongEvidence(m);
      const inferred = !strong && args.includeInferred && isPaidMemberByInference(m);
      if (!strong && !inferred) continue;

      rows.push({
        clientUid,
        clientEmail: pickString(c.Email) || null,
        clientFirstName: pickString(c['First Name'] ?? c['Father Name']) || null,
        clientLastName: pickString(c['Last Name']) || null,
        memberId: memberDoc.id,
        memberFirstName: pickString(m['First Name']) || null,
        memberLastName: pickString(m['Last Name']) || null,
        relationship: pickString(m['Family Member Status'] ?? m.familyMemberStatus) || null,
        serviceActivationPaymentId: pickString(m.serviceActivationPaymentId) || null,
        selectedCardId: pickString(m.selectedCardId) || null,
        inferredPaid: inferred
      });
    }
  }

  rows.sort((a, b) => {
    const byEmail = String(a.clientEmail || '').localeCompare(String(b.clientEmail || ''));
    if (byEmail !== 0) return byEmail;
    return a.clientUid.localeCompare(b.clientUid);
  });

  const limitedRows = args.limit > 0 ? rows.slice(0, args.limit) : rows;
  const uniqueClients = new Set(limitedRows.map((r) => r.clientUid));

  console.log('[list-clients-with-paid-family-members] Résumé', {
    totalPaidMembersFound: rows.length,
    returnedRows: limitedRows.length,
    uniqueClients: uniqueClients.size,
    inferredRows: limitedRows.filter((r) => r.inferredPaid).length
  });

  if (args.json) {
    console.log(JSON.stringify(limitedRows, null, 2));
    return;
  }

  if (limitedRows.length === 0) {
    console.log('Aucun membre famille payant trouvé.');
    return;
  }

  console.log('');
  console.log('clientUid | email | memberId | memberName | relation | paymentId | inferred');
  console.log('--------- | ----- | -------- | ---------- | -------- | --------- | --------');
  for (const r of limitedRows) {
    const memberName = `${r.memberFirstName || ''} ${r.memberLastName || ''}`.trim() || '-';
    console.log(
      `${r.clientUid} | ${r.clientEmail || '-'} | ${r.memberId} | ${memberName} | ${r.relationship || '-'} | ${
        r.serviceActivationPaymentId || '-'
      } | ${r.inferredPaid ? 'yes' : 'no'}`
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[list-clients-with-paid-family-members] Erreur:', e?.message || String(e));
    process.exit(1);
  });
