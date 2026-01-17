import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80",
        outline: "text-foreground",
        supply: "border-transparent bg-green-600 text-white",
        withdraw: "border-transparent bg-red-600 text-white",
        borrow: "border-transparent bg-purple-600 text-white",
        repay: "border-transparent bg-yellow-600 text-white",
        claim: "border-transparent bg-teal-600 text-white",
        supply_collateral: "border-transparent bg-blue-600 text-white",
        withdraw_collateral: "border-transparent bg-orange-600 text-white",
        // Backstop variants
        deposit: "border-transparent bg-green-600 text-white",
        queue_withdrawal: "border-transparent bg-yellow-600 text-white",
        dequeue_withdrawal: "border-transparent bg-yellow-500 text-white",
        donate: "border-transparent bg-teal-600 text-white",
        draw: "border-transparent bg-red-700 text-white",
        gulp_emissions: "border-transparent bg-purple-500 text-white",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
