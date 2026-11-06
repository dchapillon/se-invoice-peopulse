// Détection et lecture des différents formats XML de factures.
//
// - PEOPULSE : une seule facture, <InvoiceNumber> + <EmbeddedPdf>
// - PILOTT   : HR-XML, une facture, <DocumentId><Id> + <EmbeddedData><Data>
// - PIXID    : HR-XML avec préfixe "xs:", PLUSIEURS <Invoice> dans un même fichier,
//              <xs:DocumentId><xs:Id> + <xs:EmbeddedData><xs:Data>

export type InvoiceFormat = "PEOPULSE" | "PIXID" | "PILOTT" | "INCONNU";

export interface InvoiceEntry {
  /** Numéro de facture lu dans le XML */
  number: string;
  /** Position du numéro dans le texte XML (null si absent) */
  numberSpan: { start: number; end: number } | null;
  /** Position du contenu base64 du PDF dans le texte XML (null si absent) */
  pdfSpan: { start: number; end: number } | null;
}

export interface ParsedInvoiceFile {
  format: InvoiceFormat;
  invoices: InvoiceEntry[];
}

// Cherche `re` (groupe 1 = préfixe, groupe 2 = valeur) dans text[from, to)
const findSpan = (text: string, re: RegExp, from: number, to: number) => {
  const m = re.exec(text.slice(from, to));
  if (!m) return null;
  const start = from + m.index + m[1].length;
  return { value: m[2], start, end: start + m[2].length };
};

const NUMBER_PEOPULSE = /(<InvoiceNumber>)([^<]*)(?=<\/InvoiceNumber>)/;
const PDF_PEOPULSE = /(<EmbeddedPdf>)([\s\S]*?)(?=<\/EmbeddedPdf>)/;
const NUMBER_HRXML = /(<(?:xs:)?DocumentId>\s*<(?:xs:)?Id>)([^<]*)(?=<\/(?:xs:)?Id>)/;
const PDF_HRXML = /(<(?:xs:)?EmbeddedData\b[^>]*>\s*<(?:xs:)?Data>)([\s\S]*?)(?=<\/(?:xs:)?Data>)/;

const toEntry = (
  text: string,
  numberRe: RegExp,
  pdfRe: RegExp,
  from: number,
  to: number
): InvoiceEntry => {
  const num = findSpan(text, numberRe, from, to);
  const pdf = findSpan(text, pdfRe, from, to);
  return {
    number: num?.value.trim() ?? "",
    numberSpan: num && { start: num.start, end: num.end },
    pdfSpan: pdf && { start: pdf.start, end: pdf.end },
  };
};

export const parseInvoiceFile = (text: string): ParsedInvoiceFile => {
  if (/<EmbeddedPdf>|<InvoiceNumber>/.test(text)) {
    return {
      format: "PEOPULSE",
      invoices: [toEntry(text, NUMBER_PEOPULSE, PDF_PEOPULSE, 0, text.length)],
    };
  }

  let format: InvoiceFormat = "INCONNU";
  if (/idOwner="PILOTT"/.test(text)) format = "PILOTT";
  else if (/<xs:EmbeddedData|PIXID/.test(text)) format = "PIXID";

  // Une entrée par bloc <Invoice>…</Invoice> (le premier DocumentId du bloc est
  // celui de l'en-tête ; les suivants sont des références, ex. facture d'un avoir)
  const invoices: InvoiceEntry[] = [];
  const blockRe = /<Invoice>[\s\S]*?<\/Invoice>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text))) {
    invoices.push(toEntry(text, NUMBER_HRXML, PDF_HRXML, m.index, m.index + m[0].length));
  }
  if (invoices.length === 0) {
    // Pas de bloc <Invoice> identifiable : on tente sur tout le fichier
    const entry = toEntry(text, NUMBER_HRXML, PDF_HRXML, 0, text.length);
    if (entry.numberSpan || entry.pdfSpan) invoices.push(entry);
  }
  return { format, invoices };
};

/** Base64 du PDF, nettoyé des retours chariot encodés (&#13;) et des espaces */
export const extractPdfBase64 = (text: string, entry: InvoiceEntry) =>
  entry.pdfSpan
    ? text.slice(entry.pdfSpan.start, entry.pdfSpan.end).replace(/&#13;/g, "").replace(/\s/g, "")
    : "";

/** Numéro proposé par défaut pour l'annotation */
export const defaultAnnotationText = (format: InvoiceFormat, number: string) => {
  if (!number) return "";
  // Ajoute le préfixe "FE" sauf s'il est déjà présent (évite "FEFE…")
  const withFe = (n: string) => (/^FE/i.test(n) ? n : "FE" + n);
  switch (format) {
    case "PEOPULSE": // "FE" + numéro sans "/"
      return withFe(number.replace(/\//g, ""));
    case "PILOTT": // ex. 0Y91003168 -> FE0Y91003168
      return withFe(number);
    default: // PIXID : le numéro est déjà au bon format
      return number;
  }
};

/** Remplace le numéro et/ou le PDF d'une facture dans le texte XML */
export const applyInvoiceChanges = (
  text: string,
  entry: InvoiceEntry,
  changes: { number?: string; pdfBase64?: string }
) => {
  const edits: { start: number; end: number; value: string }[] = [];
  if (changes.number !== undefined && entry.numberSpan) {
    edits.push({ ...entry.numberSpan, value: changes.number });
  }
  if (changes.pdfBase64 !== undefined && entry.pdfSpan) {
    edits.push({ ...entry.pdfSpan, value: changes.pdfBase64 });
  }
  // De la fin vers le début pour ne pas décaler les positions restantes
  edits.sort((a, b) => b.start - a.start);
  return edits.reduce((acc, e) => acc.slice(0, e.start) + e.value + acc.slice(e.end), text);
};
