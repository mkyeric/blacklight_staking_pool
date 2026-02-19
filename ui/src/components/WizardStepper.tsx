"use client";

type WizardStep = {
  id: string;
  label: string;
  description?: string;
};

type WizardStepperProps = {
  steps: WizardStep[];
  currentStep: number;
  completedSteps?: number[];
};

/**
 * Visual stepper for wizard-style workflows. Shows steps with progress
 * and clear labeling for multi-step flows (e.g. Approve → Stake).
 */
export function WizardStepper({
  steps,
  currentStep,
  completedSteps = [],
}: WizardStepperProps) {
  return (
    <nav aria-label="Progress" className="mb-6">
      <ol className="flex items-center gap-2">
        {steps.map((step, index) => {
          const isCompleted =
            completedSteps.includes(index) || index < currentStep;
          const isCurrent = index === currentStep;
          const isPast = index < currentStep;

          return (
            <li
              key={step.id}
              className={`flex flex-1 items-center ${index < steps.length - 1 ? "" : ""}`}
            >
              <div className="flex flex-col items-center flex-1">
                <div
                  className={`
                    flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 text-sm font-semibold transition-colors
                    ${
                      isCompleted
                        ? "border-blacklight-success bg-blacklight-success/20 text-blacklight-success"
                        : isCurrent
                        ? "border-blacklight-accent bg-blacklight-accent/20 text-blacklight-accent"
                        : "border-blacklight-border bg-blacklight-surface text-blacklight-text-muted"
                    }
                  `}
                  aria-current={isCurrent ? "step" : undefined}
                >
                  {isCompleted ? (
                    <svg
                      className="h-5 w-5"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                      aria-hidden
                    >
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                  ) : (
                    index + 1
                  )}
                </div>
                <span
                  className={`mt-1.5 text-xs font-medium ${
                    isCurrent
                      ? "text-blacklight-accent"
                      : isCompleted
                      ? "text-blacklight-success"
                      : "text-blacklight-text-muted"
                  }`}
                >
                  {step.label}
                </span>
              </div>
              {index < steps.length - 1 && (
                <div
                  className={`h-0.5 flex-1 min-w-[16px] mx-1 rounded ${
                    isPast || isCompleted
                      ? "bg-blacklight-success/50"
                      : "bg-blacklight-border"
                  }`}
                  aria-hidden
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
