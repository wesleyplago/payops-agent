import { createHash } from 'node:crypto';
import { containsPii } from '../domain/pii';

export type KbDocument = {
  id: string;
  title: string;
  content: string;
  source?: string;
};

export type DocumentScan = {
  id: string;
  title: string;
  trust: 'untrusted';
  content_sha256: string;
  suspicious: boolean;
  categories: string[];
  pii_present: boolean;
  quarantine: boolean;
};

export type ScannedDocuments = {
  documents: DocumentScan[];
  /** Clean documents may be shown to the model as data. Suspicious ones do not. */
  data_channel: Array<{ id: string; title: string; content: string; trust: 'untrusted-data' }>;
  suspicious_count: number;
  quarantined_count: number;
  pii_documents: number;
};

const RULES: Array<{ category: string; pattern: RegExp }> = [
  {
    category: 'ignore_previous_instructions',
    pattern:
      /\b(ignore|disregard|forget)\b[^.]{0,40}\b(previous|prior|above|all)\b[^.]{0,25}\b(instructions?|prompts?|rules?)\b/i,
  },
  {
    category: 'ignore_previous_instructions',
    pattern:
      /\b(desconsidere|ignore|esqueça)\b[^.]{0,40}\b(instruções|regras|comandos)\b/i,
  },
  {
    category: 'ignore_previous_instructions',
    pattern: /\b(system prompt|prompt do sistema|you are now|você agora é|developer mode|modo manutenção)\b/i,
  },
  {
    category: 'request_refund',
    pattern: /\b(refund|estorn\w*|devolv\w*|chargeback)\b/i,
  },
  {
    category: 'exfiltrate_pii',
    pattern: /\b(cpf|pii|ssn|passport|senha|password|dados pessoais|cartão de crédito)\b/i,
  },
  {
    category: 'exfiltrate_pii',
    pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  },
  {
    category: 'change_policy',
    pattern:
      /\b(policy|política|limite|limit|sem aprovação|without approval|no longer require|nova regra|override)\b/i,
  },
  {
    category: 'forge_approval',
    pattern:
      /\b(approval token|token de aprovação|já aprovado|already approved|approval granted|apv_[a-z0-9_-]+)\b/i,
  },
];

export function scanDocuments(documents: KbDocument[]): ScannedDocuments {
  const scans: DocumentScan[] = [];
  const dataChannel: ScannedDocuments['data_channel'] = [];

  for (const doc of documents) {
    const categories = new Set<string>();
    for (const rule of RULES) {
      if (rule.pattern.test(doc.content) || rule.pattern.test(doc.title)) {
        categories.add(rule.category);
      }
    }
    const pii = containsPii(doc.content);
    if (pii) categories.add('exfiltrate_pii');

    const suspicious =
      categories.size > 0 ||
      /```|<\/?system>|<\|im_start\|>|BEGIN INSTRUCTION/i.test(doc.content);
    const scan: DocumentScan = {
      id: doc.id,
      title: doc.title,
      trust: 'untrusted',
      content_sha256: createHash('sha256').update(doc.content).digest('hex'),
      suspicious,
      categories: [...categories].sort(),
      pii_present: pii,
      quarantine: suspicious || pii,
    };
    scans.push(scan);
    if (!scan.quarantine) {
      dataChannel.push({
        id: doc.id,
        title: doc.title,
        content: doc.content,
        trust: 'untrusted-data',
      });
    }
  }

  return {
    documents: scans,
    data_channel: dataChannel,
    suspicious_count: scans.filter((s) => s.suspicious).length,
    quarantined_count: scans.filter((s) => s.quarantine).length,
    pii_documents: scans.filter((s) => s.pii_present).length,
  };
}
