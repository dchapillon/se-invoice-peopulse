import { useState, useRef, useCallback, useEffect } from "react";
import { Upload, Download, Check, Type, Move } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import StepIndicator from "./StepIndicator";

declare const pdfjsLib: any;
declare const jspdf: any;

const STEPS = ["XML Import", "PDF Display", "Annotate", "Download"];
// Dynamic transformation: prefix "FE" + remove "/"

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
  const [transformedInvoiceNumber, setTransformedInvoiceNumber] = useState("");
  const [fileName, setFileName] = useState("");
  const [originalInvoiceNumber, setOriginalInvoiceNumber] = useState("");
  const [replacementDone, setReplacementDone] = useState(false);
  const [pdfBase64, setPdfBase64] = useState("");
  const [annotations, setAnnotations] = useState<TextAnnotation[]>([]);
  const [activeAnnotation, setActiveAnnotation] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [canvasReady, setCanvasReady] = useState(false);
  const [pdfPages, setPdfPages] = useState<PageData[]>([]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Step 1: Handle XML upload
  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);

    const reader = new FileReader();
    reader.onload = (ev) => {
      let text = ev.target?.result as string;
      // Extract original invoice number
      const invoiceMatch = text.match(/<InvoiceNumber>(.*?)<\/InvoiceNumber>/);
      if (invoiceMatch) {
        const original = invoiceMatch[1];
        setOriginalInvoiceNumber(original);
        // Transform: prefix "FE" + remove "/"
        const transformed = "FE" + original.replace(/\//g, "");
        setTransformedInvoiceNumber(transformed);
        setReplacementDone(true);
      } else {
        setReplacementDone(false);
      }
      setXmlContent(text);
      setStep(2);
    };
    // Read as ISO-8859-1
    reader.readAsText(file, "iso-8859-1");
  }, []);

  // Step 2: Extract and render PDF (all pages)
  useEffect(() => {
    if (step !== 2 || !xmlContent) return;
    if (step !== 2 || !xmlContent) return;

    const match = xmlContent.match(/<EmbeddedPdf>([\s\S]*?)<\/EmbeddedPdf>/);
    if (!match) return;

    let base64 = match[1];
    base64 = base64.replace(/&#13;/g, "").replace(/\s/g, "");
    setPdfBase64(base64);

    const binaryStr = atob(base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    const loadingTask = pdfjsLib.getDocument({ data: bytes });
    loadingTask.promise.then(async (pdf: any) => {
      const scale = 2;
      const pages: PageData[] = [];
      let totalHeight = 0;
      let maxWidth = 0;

      // Render each page to an offscreen canvas to capture ImageData
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const viewport = page.getViewport({ scale });
        const offscreen = document.createElement("canvas");
        offscreen.width = viewport.width;
        offscreen.height = viewport.height;
        const offCtx = offscreen.getContext("2d")!;
        await page.render({ canvasContext: offCtx, viewport }).promise;

        pages.push({
          imageData: offCtx.getImageData(0, 0, viewport.width, viewport.height),
          width: viewport.width,
          height: viewport.height,
          yOffset: totalHeight,
        });
        totalHeight += viewport.height;
        if (viewport.width > maxWidth) maxWidth = viewport.width;
      }

      // Draw all pages on the main canvas
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = maxWidth;
      canvas.height = totalHeight;
      const ctx = canvas.getContext("2d")!;
      pages.forEach((pg) => {
        ctx.putImageData(pg.imageData, 0, pg.yOffset);
      });

      setPdfPages(pages);
      setCanvasReady(true);
    });
  }, [step, xmlContent]);

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
        fontSize: 28,
        color: "#000000",
        bold: false,
        confirmed: false,
      };
      setAnnotations((prev) => [...prev, newAnnotation]);
      setActiveAnnotation(annotations.length);
    },
    [step, canvasReady, annotations]
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

      if (Math.abs(mx - ann.x) < 150 && Math.abs(my - ann.y) < 40) {
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
    if (!canvasReady || !pdfPageData) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.putImageData(pdfPageData, 0, 0);

    annotations.forEach((ann) => {
      ctx.font = `${ann.bold ? "bold " : ""}${ann.fontSize}px sans-serif`;
      const metrics = ctx.measureText(ann.text);
      // Draw white background to mask content underneath
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(ann.x - 2, ann.y - ann.fontSize, metrics.width + 4, ann.fontSize + 4);
      // Draw the text on top
      ctx.fillStyle = ann.color;
      ctx.fillText(ann.text, ann.x, ann.y);
      if (!ann.confirmed) {
        // Draw dashed border around unconfirmed
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = "hsl(215, 80%, 48%)";
        ctx.lineWidth = 2;
        const metrics = ctx.measureText(ann.text);
        ctx.strokeRect(ann.x - 4, ann.y - ann.fontSize, metrics.width + 8, ann.fontSize + 8);
        ctx.setLineDash([]);
      }
    });
  }, [annotations, canvasReady, pdfPageData]);

  // Update active annotation properties
  const updateAnnotation = (key: keyof TextAnnotation, value: any) => {
    if (activeAnnotation === null) return;
    setAnnotations((prev) =>
      prev.map((a, i) => (i === activeAnnotation ? { ...a, [key]: value } : a))
    );
  };

  const confirmAnnotation = () => {
    if (activeAnnotation === null) return;
    const ann = annotations[activeAnnotation];
    // Update the InvoiceNumber tag in the XML with the annotation text
    setXmlContent((prev) =>
      prev.replace(/<InvoiceNumber>.*?<\/InvoiceNumber>/, `<InvoiceNumber>${ann.text}</InvoiceNumber>`)
    );
    updateAnnotation("confirmed", true);
    setActiveAnnotation(null);
  };

  // Step 4: Re-encode and download
  const handleDownload = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Create PDF from canvas using jsPDF
    const { jsPDF } = jspdf;
    const imgData = canvas.toDataURL("image/jpeg", 0.95);
    const pxToMm = 25.4 / 96;
    const wMm = (canvas.width / 2) * pxToMm;
    const hMm = (canvas.height / 2) * pxToMm;
    const doc = new jsPDF({ orientation: wMm > hMm ? "l" : "p", unit: "mm", format: [wMm, hMm] });
    doc.addImage(imgData, "JPEG", 0, 0, wMm, hMm);

    const pdfArrayBuffer = doc.output("arraybuffer");
    const pdfBytes = new Uint8Array(pdfArrayBuffer);
    let binary = "";
    for (let i = 0; i < pdfBytes.length; i++) {
      binary += String.fromCharCode(pdfBytes[i]);
    }
    const newBase64 = btoa(binary);

    // Replace in XML
    const finalXml = xmlContent.replace(
      /<EmbeddedPdf>[\s\S]*?<\/EmbeddedPdf>/,
      `<EmbeddedPdf>${newBase64}</EmbeddedPdf>`
    );

    // Encode as ISO-8859-1
    const buf = new Uint8Array(finalXml.length);
    for (let i = 0; i < finalXml.length; i++) {
      buf[i] = finalXml.charCodeAt(i) & 0xff;
    }
    const blob = new Blob([buf], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName.replace(".xml", "_modified.xml");
    a.click();
    URL.revokeObjectURL(url);
  }, [xmlContent, fileName]);

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
          {originalInvoiceNumber && step >= 2 && (
            <div className="mt-3 p-3 bg-secondary rounded-md text-sm text-foreground">
              <span className="text-muted-foreground">Numéro de facture trouvé :</span>{" "}
              <span className="font-semibold">{originalInvoiceNumber}</span>
            </div>
          )}
          {fileName && !originalInvoiceNumber && step >= 2 && (
            <Badge variant="secondary" className="mt-2">
              Aucune balise InvoiceNumber trouvée
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
              />
            </div>
          )}
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
                Click on the PDF above to place text. Drag to reposition before confirming.
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
                      onChange={(e) => updateAnnotation("fontSize", parseInt(e.target.value) || 14)}
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
                <Button onClick={() => setStep(4)} className="mt-4 gap-2">
                  <Move className="w-4 h-4" /> Proceed to Download
                </Button>
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
              <Button onClick={handleDownload} className="gap-2">
                <Download className="w-4 h-4" /> Download Modified XML
              </Button>
            </>
          )}
        </section>
      </div>
    </div>
  );
};

export default InvoiceEditor;
