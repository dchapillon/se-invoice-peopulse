import { describe, expect, it } from "vitest";
import {
  applyInvoiceChanges,
  defaultAnnotationText,
  extractPdfBase64,
  parseInvoiceFile,
} from "./invoiceFormats";

const PEOPULSE = `<Root><InvoiceNumber>1J9/1001948</InvoiceNumber><EmbeddedPdf>JVBE&#13;
Ri0x</EmbeddedPdf></Root>`;

const PILOTT = `<Envelope><Sender><Id idOwner="PILOTT"><IdValue>1</IdValue></Id></Sender><Invoice><Header>
<DocumentIds><DocumentId><Id>0Y91003168</Id></DocumentId></DocumentIds>
<Attachments><Attachment><EmbeddedData encoding="base64"><Data>JVBERi0x</Data></EmbeddedData></Attachment></Attachments>
</Header></Invoice></Envelope>`;

const pixidInvoice = (id: string, ref: string, pdf: string) =>
  `<Invoice><xs:Header><xs:DocumentIds><xs:DocumentId><xs:Id>${id}</xs:Id></xs:DocumentId></xs:DocumentIds>` +
  (ref
    ? `<xs:DocumentReferences><xs:DocumentIds><xs:DocumentId><xs:Id>${ref}</xs:Id></xs:DocumentId></xs:DocumentIds></xs:DocumentReferences>`
    : "") +
  `<xs:Attachments><xs:Attachment><xs:EmbeddedData encoding="BASE 64"><xs:Data>${pdf}</xs:Data></xs:EmbeddedData></xs:Attachment></xs:Attachments></xs:Header></Invoice>`;

const PIXID = `<!-- PIXID_ETT --><Envelope><Packet><InvoicePacket>${pixidInvoice("AE01", "FE00", "QUFB&#13;\nQQ==")}</InvoicePacket>
<InvoicePacket>${pixidInvoice("FE02", "", "QkJC")}</InvoicePacket></Packet></Envelope>`;

describe("parseInvoiceFile", () => {
  it("lit une facture PEOPULSE", () => {
    const { format, invoices } = parseInvoiceFile(PEOPULSE);
    expect(format).toBe("PEOPULSE");
    expect(invoices).toHaveLength(1);
    expect(invoices[0].number).toBe("1J9/1001948");
    expect(extractPdfBase64(PEOPULSE, invoices[0])).toBe("JVBERi0x");
    expect(defaultAnnotationText(format, invoices[0].number)).toBe("FE1J91001948");
    // Pas de doublon si le numéro porte déjà le préfixe
    expect(defaultAnnotationText(format, "FE1J9/1001948")).toBe("FE1J91001948");
  });

  it("lit une facture PILOTT", () => {
    const { format, invoices } = parseInvoiceFile(PILOTT);
    expect(format).toBe("PILOTT");
    expect(invoices.map((i) => i.number)).toEqual(["0Y91003168"]);
    expect(extractPdfBase64(PILOTT, invoices[0])).toBe("JVBERi0x");
    expect(defaultAnnotationText(format, "0Y91003168")).toBe("FE0Y91003168");
    expect(defaultAnnotationText(format, "FE0Y91003168")).toBe("FE0Y91003168");
  });

  it("lit plusieurs factures PIXID et prend le numéro d'en-tête, pas la référence", () => {
    const { format, invoices } = parseInvoiceFile(PIXID);
    expect(format).toBe("PIXID");
    expect(invoices.map((i) => i.number)).toEqual(["AE01", "FE02"]);
    expect(extractPdfBase64(PIXID, invoices[0])).toBe("QUFBQQ==");
    expect(extractPdfBase64(PIXID, invoices[1])).toBe("QkJC");
  });
});

describe("applyInvoiceChanges", () => {
  it("ne modifie que la facture ciblée", () => {
    const { invoices } = parseInvoiceFile(PIXID);
    const out = applyInvoiceChanges(PIXID, invoices[1], { number: "FE99", pdfBase64: "Q0ND" });
    const after = parseInvoiceFile(out).invoices;
    expect(after.map((i) => i.number)).toEqual(["AE01", "FE99"]);
    expect(extractPdfBase64(out, after[0])).toBe("QUFBQQ==");
    expect(extractPdfBase64(out, after[1])).toBe("Q0ND");
    expect(out).toContain("<xs:Id>FE00</xs:Id>"); // référence intacte
  });
});
