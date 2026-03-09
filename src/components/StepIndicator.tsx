import { Check } from "lucide-react";

interface StepIndicatorProps {
  steps: string[];
  currentStep: number;
}

const StepIndicator = ({ steps, currentStep }: StepIndicatorProps) => {
  return (
    <div className="flex items-center justify-center gap-2 mb-8">
      {steps.map((label, i) => {
        const stepNum = i + 1;
        const isDone = currentStep > stepNum;
        const isActive = currentStep === stepNum;
        return (
          <div key={i} className="flex items-center gap-2">
            <div
              className={`flex items-center justify-center w-9 h-9 rounded-full text-sm font-semibold transition-colors ${
                isDone
                  ? "bg-step-done text-accent-foreground"
                  : isActive
                  ? "bg-step-active text-primary-foreground"
                  : "bg-step-pending/30 text-muted-foreground"
              }`}
            >
              {isDone ? <Check className="w-4 h-4" /> : stepNum}
            </div>
            <span
              className={`text-sm hidden sm:inline ${
                isActive ? "font-semibold text-foreground" : "text-muted-foreground"
              }`}
            >
              {label}
            </span>
            {i < steps.length - 1 && (
              <div className={`w-8 h-0.5 ${isDone ? "bg-step-done" : "bg-border"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
};

export default StepIndicator;
