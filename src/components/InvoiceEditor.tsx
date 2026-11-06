import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Upload, Download, Check, Type, Move, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import StepIndicator from "./StepIndicator";
import {
  parseInvoiceFile,
  extractPdfBase64,
  defaultAnnotationText,
  applyInvoiceChanges,
} from "@/lib/invoiceFormats";

// Bibliothèques chargées par CDN (voir index.html), typées au strict nécessaire
interface PdfPage {
  getViewport(opts: { scale: number }): { width: number; height: number };
  render(opts: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }): { promise: Promise<void> };
}
interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}
interface JsPdfDoc {
  addPage(format: [number, number], orientation: string): void;
  addImage(data: string, type: string, x: number, y: number, w: number, h: number): void;
  output(type: "arraybuffer"): ArrayBuffer;
}
declare const pdfjsLib: {
  getDocument(src: { data: Uint8Array }): { promise: Promise<PdfDocument> };
};
declare const jspdf: {
  jsPDF: new (opts: { orientation: string; unit: string; format: [number, number] }) => JsPdfDoc;
};

const STEPS = ["XML Import", "PDF Display", "Annotate", "Download"];

// Rendu PDF.js : 1 unité de viewport = 1 point (1/72 pouce) à scale 1
const RENDER_SCALE = 2;
const PT_TO_MM = 25.4 / 72;

// Échappe un texte pour l'insérer dans du XML. Les caractères hors Latin-1
// (non représentables dans le fichier ISO-8859-1) deviennent des références numériques.
const escapeXml = (text: string) => {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === "&") out += "&amp;";
    else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else if (code > 0xff) out += `&#${code};`;
    else out += ch;
  }
  return out;
};

interface TextAnnotation {
  text: string;
  x: number;
  y: number;
  fontSize: number;
  color: string;
  bold: boolean;
  confirmed: boolean;
}

interface PageData {
  imageData: ImageData;
  width: number;
  height: number;
  yOffset: number;
}

const InvoiceEditor = () => {
  const [step, setStep] = useState(1);
  const [xmlContent, setXmlContent] = useState("");
  const [fileName, setFileName] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(-1);
  // Factures déjà annotées et intégrées au XML (fichiers multi-factures PIXID)
  const [processed, setProcessed] = useState<Set<number>>(new Set());
  const [loadId, setLoadId] = useState(0);
  const [error, setError] = useState("");
  const [annotations, setAnnotations] = useState<TextAnnotation[]>([]);
  const [activeAnnotation, setActiveAnnotation] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [canvasReady, setCanvasReady] = useState(false);
  const [pdfPages, setPdfPages] = useState<PageData[]>([]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Format et liste des factures, recalculés à chaque modification du XML
  const parsed = useMemo(() => parseInvoiceFile(xmlContent), [xmlContent]);
  const currentInvoice = parsed.invoices[selectedIdx] ?? null;
  const originalInvoiceNumber = currentInvoice?.number ?? "";
  const transformedInvoiceNumber = defaultAnnotationText(parsed.format, originalInvoiceNumber);
  const pdfBase64 = currentInvoice ? extractPdfBase64(xmlContent, currentInvoice) : "";

  // Réinitialise l'annotation en cours et (re)charge la facture choisie
  const selectInvoice = useCallback((idx: number) => {
    setAnnotations([]);
    setActiveAnnotation(null);
    setIsDragging(false);
    setCanvasReady(false);
    setPdfPages([]);
    setError("");
    setSelectedIdx(idx);
    setLoadId((n) => n + 1);
    setStep(2);
  }, []);

  // Step 1: Handle XML upload
  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setFileName(file.name);
      // Permet de re-sélectionner le même fichier
      e.target.value = "";

      const reader = new FileReader();
      reader.onerror = () => setError("Impossible de lire le fichier.");
      reader.onload = (ev) => {
        const text = ev.target?.result as string;
        const { invoices } = parseInvoiceFile(text);
        const firstWithPdf = invoices.findIndex((inv) => inv.pdfSpan);

        setXmlContent(text);
        setProcessed(new Set());
        selectInvoice(firstWithPdf);
        if (firstWithPdf < 0) {
          setError("Aucun PDF embarqué trouvé dans ce fichier (formats gérés : PEOPULSE, PIXID, PILOTT).");
        }
      };
      // Read as ISO-8859-1
      reader.readAsText(file, "iso-8859-1");
    },
    [selectInvoice]
  );

  // Step 2: Render PDF (all pages). Ne dépend que du PDF, pas du XML modifié.
  useEffect(() => {
    if (!pdfBase64) return;
    let cancelled = false;

    (async () => {
      try {
        if (typeof pdfjsLib === "undefined") throw new Error("pdf.js n'est pas chargé");
        const binaryStr = atob(pdfBase64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }

        const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
        const pages: PageData[] = [];
        let totalHeight = 0;
        let maxWidth = 0;

        // Render each page to an offscreen canvas to capture ImageData
        for (let p = 1; p <= pdf.numPages; p++) {
          const page = await pdf.getPage(p);
          const viewport = page.getViewport({ scale: RENDER_SCALE });
          const offscreen = document.createElement("canvas");
          offscreen.width = viewport.width;
          offscreen.height = viewport.height;
          const offCtx = offscreen.getContext("2d")!;
          await page.render({ canvasContext: offCtx, viewport }).promise;

          pages.push({
            imageData: offCtx.getImageData(0, 0, offscreen.width, offscreen.height),
            width: offscreen.width,
            height: offscreen.height,
            yOffset: totalHeight,
          });
          totalHeight += offscreen.height;
          if (offscreen.width > maxWidth) maxWidth = offscreen.width;
        }
        if (cancelled) return;

        // Draw all pages on the main canvas
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = maxWidth;
        canvas.height = totalHeight;
        const ctx = canvas.getContext("2d")!;
        pages.forEach((pg) => ctx.putImageData(pg.imageData, 0, pg.yOffset));

        setPdfPages(pages);
        setCanvasReady(true);
      } catch (err) {
        if (!cancelled) {
          console.error(err);
          setError("Impossible d'afficher le PDF embarqué (données invalides ?).");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadId, pdfBase64]);

  // Step 3: Click on canvas to place annotation
  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (step < 3 || !canvasReady) return;
      // Don't add new annotation if one is being dragged or unconfirmed
      if (annotations.some((a) => !a.confirmed)) return;

      const canvas = canvasRef.current!;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;

      const newAnnotation: TextAnnotation = {
        text: transformedInvoiceNumber,
        x,
        y,
        fontSize: 18,
        color: "#000000",
        bold: true,
        confirmed: false,
      };
      setAnnotations((prev) => [...prev, newAnnotation]);
      setActiveAnnotation(annotations.length);
    },
    [step, canvasReady, annotations, transformedInvoiceNumber]
  );

  // Drag handling
  const handleCanvasMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (activeAnnotation === null) return;
      const ann = annotations[activeAnnotation];
      if (ann?.confirmed) return;

      const canvas = canvasRef.current!;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const mx = (e.clientX - rect.left) * scaleX;
      const my = (e.clientY - rect.top) * scaleY;

      // Zone de prise = boîte réelle du texte (+ marge)
      const ctx = canvas.getContext("2d")!;
      ctx.font = `${ann.bold ? "bold " : ""}${ann.fontSize}px sans-serif`;
      const textWidth = ctx.measureText(ann.text).width;
      const margin = 10;
      if (
        mx >= ann.x - margin &&
        mx <= ann.x + textWidth + margin &&
        my >= ann.y - ann.fontSize - margin &&
        my <= ann.y + margin
      ) {
        setIsDragging(true);
        setDragOffset({ x: mx - ann.x, y: my - ann.y });
        e.preventDefault();
      }
    },
    [activeAnnotation, annotations]
  );

  const handleCanvasMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!isDragging || activeAnnotation === null) return;
      const canvas = canvasRef.current!;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const mx = (e.clientX - rect.left) * scaleX;
      const my = (e.clientY - rect.top) * scaleY;

      setAnnotations((prev) =>
        prev.map((a, i) =>
          i === activeAnnotation ? { ...a, x: mx - dragOffset.x, y: my - dragOffset.y } : a
        )
      );
    },
    [isDragging, activeAnnotation, dragOffset]
  );

  const handleCanvasMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Redraw canvas with annotations
  useEffect(() => {
    if (!canvasReady || pdfPages.length === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    // Redraw all pages
    pdfPages.forEach((pg) => {
      ctx.putImageData(pg.imageData, 0, pg.yOffset);
    });

    annotations.forEach((ann) => {
      ctx.font = `${ann.bold ? "bold " : ""}${ann.fontSize}px sans-serif`;
      const metrics = ctx.measureText(ann.text);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(ann.x - 2, ann.y - ann.fontSize, metrics.width + 4, ann.fontSize + 4);
      ctx.fillStyle = ann.color;
      ctx.fillText(ann.text, ann.x, ann.y);
      if (!ann.confirmed) {
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = "hsl(215, 80%, 48%)";
        ctx.lineWidth = 2;
        const m = ctx.measureText(ann.text);
        ctx.strokeRect(ann.x - 4, ann.y - ann.fontSize, m.width + 8, ann.fontSize + 8);
        ctx.setLineDash([]);
      }
    });
  }, [annotations, canvasReady, pdfPages]);

  // Update active annotation properties
  const updateAnnotation = (key: keyof TextAnnotation, value: string | number | boolean) => {
    if (activeAnnotation === null) return;
    setAnnotations((prev) =>
      prev.map((a, i) => (i === activeAnnotation ? { ...a, [key]: value } : a))
    );
  };

  const confirmAnnotation = () => {
    if (activeAnnotation === null) return;
    const ann = annotations[activeAnnotation];
    if (!ann.text.trim()) return;
    updateAnnotation("confirmed", true);
    setActiveAnnotation(null);
  };

  // XML final : facture courante mise à jour (numéro = dernière annotation confirmée,
  // PDF = rendu annoté). Les factures déjà traitées sont déjà intégrées à xmlContent.
  const buildFinalXml = useCallback((): string | null => {
    const canvas = canvasRef.current;
    if (!canvas || pdfPages.length === 0 || !currentInvoice) return null;

    if (typeof jspdf === "undefined") {
      setError("jsPDF n'est pas chargé : impossible de générer le PDF.");
      return null;
    }
    const { jsPDF } = jspdf;
    const srcCtx = canvas.getContext("2d")!;

    // Create a multi-page PDF: extract each page region from the main canvas
    let doc: JsPdfDoc | null = null;
    pdfPages.forEach((pg, idx) => {
      const pageCanvas = document.createElement("canvas");
      pageCanvas.width = pg.width;
      pageCanvas.height = pg.height;
      const pCtx = pageCanvas.getContext("2d")!;
      // Copy the relevant region from the main annotated canvas
      const srcData = srcCtx.getImageData(0, pg.yOffset, pg.width, pg.height);
      pCtx.putImageData(srcData, 0, 0);

      const imgData = pageCanvas.toDataURL("image/jpeg", 0.95);
      // Pixels du canvas -> points PDF (÷ scale de rendu) -> mm (1 pt = 1/72")
      const wMm = (pg.width / RENDER_SCALE) * PT_TO_MM;
      const hMm = (pg.height / RENDER_SCALE) * PT_TO_MM;

      if (idx === 0) {
        doc = new jsPDF({ orientation: wMm > hMm ? "l" : "p", unit: "mm", format: [wMm, hMm] });
      } else {
        doc.addPage([wMm, hMm], wMm > hMm ? "l" : "p");
      }
      doc.addImage(imgData, "JPEG", 0, 0, wMm, hMm);
    });

    const pdfArrayBuffer = doc.output("arraybuffer");
    const pdfBytes = new Uint8Array(pdfArrayBuffer);
    let binary = "";
    for (let i = 0; i < pdfBytes.length; i++) {
      binary += String.fromCharCode(pdfBytes[i]);
    }
    const newBase64 = btoa(binary);

    const lastConfirmed = [...annotations].reverse().find((a) => a.confirmed && a.text.trim());
    return applyInvoiceChanges(xmlContent, currentInvoice, {
      number: lastConfirmed ? escapeXml(lastConfirmed.text.trim()) : undefined,
      pdfBase64: newBase64,
    });
  }, [xmlContent, pdfPages, currentInvoice, annotations]);

  // Step 4: Re-encode and download
  const handleDownload = useCallback(() => {
    const finalXml = buildFinalXml();
    if (finalXml === null) return;

    // Écriture en ISO-8859-1 (1 octet par caractère ; le texte saisi a été échappé)
    const buf = new Uint8Array(finalXml.length);
    for (let i = 0; i < finalXml.length; i++) {
      buf[i] = finalXml.charCodeAt(i) & 0xff;
    }
    const blob = new Blob([buf], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = /\.xml$/i.test(fileName)
      ? fileName.replace(/\.xml$/i, "_modified.xml")
      : `${fileName}_modified.xml`;
    a.click();
    URL.revokeObjectURL(url);
  }, [buildFinalXml, fileName]);

  // Multi-factures : intègre la facture courante au XML puis passe à une autre
  const commitAndSelect = (idx: number) => {
    const finalXml = buildFinalXml();
    if (finalXml === null) return;
    setXmlContent(finalXml);
    setProcessed((prev) => new Set(prev).add(selectedIdx));
    selectInvoice(idx);
  };
  const nextInvoiceIdx = parsed.invoices.findIndex(
    (inv, i) => inv.pdfSpan && i !== selectedIdx && !processed.has(i)
  );

  const activeAnn = activeAnnotation !== null ? annotations[activeAnnotation] : null;

  return (
    <div className="min-h-screen bg-background p-4 sm:p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold text-foreground text-center mb-2">
          XML Invoice Editor
        </h1>
        <p className="text-muted-foreground text-center mb-6 text-sm">
          Upload, annotate, and re-export your XML invoice with embedded PDF
        </p>

        <StepIndicator steps={STEPS} currentStep={step} />

        {/* Step 1 */}
        <section className={`mb-6 p-6 rounded-lg border transition-opacity ${step >= 1 ? "bg-card border-border" : "opacity-40 pointer-events-none bg-muted border-transparent"}`}>
          <h2 className="text-lg font-semibold text-foreground mb-3 flex items-center gap-2">
            <span className="text-primary">1.</span> XML Import
          </h2>
          <input
            type="file"
            accept=".xml"
            ref={fileInputRef}
            onChange={handleFileUpload}
            className="hidden"
          />
          <Button onClick={() => fileInputRef.current?.click()} variant="outline" className="gap-2">
            <Upload className="w-4 h-4" />
            {fileName || "Choose XML file"}
          </Button>
          {fileName && step >= 2 && xmlContent && (
            <Badge variant="outline" className="ml-3">
              Format : {parsed.format} · {parsed.invoices.length} facture
              {parsed.invoices.length > 1 ? "s" : ""}
            </Badge>
          )}
          {parsed.invoices.length > 1 && step >= 2 && (
            <div className="mt-3">
              <p className="text-sm text-muted-foreground mb-2 flex items-center gap-1">
                <ListChecks className="w-4 h-4" /> Choisissez la facture à annoter
                ({processed.size} traitée{processed.size > 1 ? "s" : ""}) :
              </p>
              <div className="flex flex-wrap gap-2">
                {parsed.invoices.map((inv, i) => (
                  <Button
                    key={i}
                    size="sm"
                    variant={i === selectedIdx ? "default" : "outline"}
                    disabled={!inv.pdfSpan}
                    title={inv.pdfSpan ? undefined : "Pas de PDF embarqué"}
                    onClick={() => i !== selectedIdx && selectInvoice(i)}
                    className="gap-1"
                  >
                    {processed.has(i) && <Check className="w-3 h-3" />}
                    {inv.number || `Facture ${i + 1}`}
                  </Button>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Changer de facture abandonne les annotations non intégrées de la facture courante.
              </p>
            </div>
          )}
          {originalInvoiceNumber && step >= 2 && (
            <div className="mt-3 p-3 bg-secondary rounded-md text-sm text-foreground">
              <span className="text-muted-foreground">Numéro de facture trouvé :</span>{" "}
              <span className="font-semibold">{originalInvoiceNumber}</span>
            </div>
          )}
          {fileName && !originalInvoiceNumber && step >= 2 && (
            <Badge variant="secondary" className="mt-2">
              Aucun numéro de facture trouvé
            </Badge>
          )}
        </section>

        {/* Step 2 */}
        <section className={`mb-6 p-6 rounded-lg border transition-opacity ${step >= 2 ? "bg-card border-border" : "opacity-40 pointer-events-none bg-muted border-transparent"}`}>
          <h2 className="text-lg font-semibold text-foreground mb-3 flex items-center gap-2">
            <span className="text-primary">2.</span> PDF Preview
          </h2>
          {step >= 2 && (
            <div className="overflow-auto max-h-[70vh] border rounded-md">
              <canvas
                ref={canvasRef}
                className="w-full cursor-crosshair"
                onClick={step >= 3 ? handleCanvasClick : undefined}
                onMouseDown={step >= 3 ? handleCanvasMouseDown : undefined}
                onMouseMove={step >= 3 ? handleCanvasMouseMove : undefined}
                onMouseUp={step >= 3 ? handleCanvasMouseUp : undefined}
                onMouseLeave={step >= 3 ? handleCanvasMouseUp : undefined}
              />
            </div>
          )}
          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
          {canvasReady && step === 2 && (
            <Button onClick={() => setStep(3)} className="mt-4 gap-2">
              <Type className="w-4 h-4" /> Proceed to Annotate
            </Button>
          )}
        </section>

        {/* Step 3 */}
        <section className={`mb-6 p-6 rounded-lg border transition-opacity ${step >= 3 ? "bg-card border-border" : "opacity-40 pointer-events-none bg-muted border-transparent"}`}>
          <h2 className="text-lg font-semibold text-foreground mb-3 flex items-center gap-2">
            <span className="text-primary">3.</span> Annotate
          </h2>
          {step >= 3 && (
            <>
              <p className="text-sm text-muted-foreground mb-3">
                Cliquez sur le PDF ci-dessus pour placer une annotation sur n'importe quelle page. Glissez pour repositionner avant de confirmer.
              </p>
              {activeAnn && !activeAnn.confirmed && (
                <div className="flex flex-wrap items-center gap-3 p-3 bg-secondary rounded-md">
                  <Input
                    value={activeAnn.text}
                    onChange={(e) => updateAnnotation("text", e.target.value)}
                    className="w-40"
                    placeholder="Text..."
                  />
                  <label className="flex items-center gap-1 text-sm text-foreground">
                    Size
                    <Input
                      type="number"
                      value={activeAnn.fontSize}
                      onChange={(e) => updateAnnotation("fontSize", parseInt(e.target.value) || 18)}
                      className="w-16"
                      min={8}
                      max={72}
                    />
                  </label>
                  <label className="flex items-center gap-1 text-sm text-foreground">
                    Color
                    <input
                      type="color"
                      value={activeAnn.color}
                      onChange={(e) => updateAnnotation("color", e.target.value)}
                      className="w-8 h-8 rounded cursor-pointer border-0"
                    />
                  </label>
                  <label className="flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      checked={activeAnn.bold}
                      onChange={(e) => updateAnnotation("bold", e.target.checked)}
                    />
                    Bold
                  </label>
                  <Button size="sm" onClick={confirmAnnotation} className="gap-1">
                    <Check className="w-3 h-3" /> Confirm
                  </Button>
                </div>
              )}
              {annotations.length > 0 && annotations.every((a) => a.confirmed) && step === 3 && (
                <div className="mt-4 flex items-center gap-4">
                  <Button onClick={() => setStep(4)} className="gap-2">
                    <Move className="w-4 h-4" /> Proceed to Download
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    ou cliquez sur le PDF pour ajouter une autre annotation
                  </span>
                </div>
              )}
            </>
          )}
        </section>

        {/* Step 4 */}
        <section className={`mb-6 p-6 rounded-lg border transition-opacity ${step >= 4 ? "bg-card border-border" : "opacity-40 pointer-events-none bg-muted border-transparent"}`}>
          <h2 className="text-lg font-semibold text-foreground mb-3 flex items-center gap-2">
            <span className="text-primary">4.</span> Download
          </h2>
          {step >= 4 && (
            <>
              <p className="text-sm text-muted-foreground mb-3">
                The annotated PDF will be re-encoded and injected back into the XML.
              </p>
              <div className="flex flex-wrap gap-3">
                <Button onClick={handleDownload} className="gap-2">
                  <Download className="w-4 h-4" /> Download Modified XML
                </Button>
                {nextInvoiceIdx >= 0 && (
                  <Button variant="outline" onClick={() => commitAndSelect(nextInvoiceIdx)} className="gap-2">
                    <ListChecks className="w-4 h-4" /> Intégrer et passer à la facture suivante
                  </Button>
                )}
              </div>
              {parsed.invoices.length > 1 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Le XML téléchargé contient toutes les factures déjà intégrées ainsi que la facture courante.
                </p>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
};

export default InvoiceEditor;
