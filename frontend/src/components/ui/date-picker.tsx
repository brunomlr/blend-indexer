import * as React from "react"
import { format } from "date-fns"
import { DayPicker } from "react-day-picker"
import { Calendar as CalendarIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

interface DatePickerProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  id?: string
}

export function DatePicker({ value, onChange, placeholder = "Pick a date", id }: DatePickerProps) {
  const [open, setOpen] = React.useState(false)
  const containerRef = React.useRef<HTMLDivElement>(null)

  const selectedDate = value ? new Date(value + "T00:00:00") : undefined

  function handleSelect(date: Date | undefined) {
    if (date) {
      onChange(format(date, "yyyy-MM-dd"))
    }
    setOpen(false)
  }

  // Close on click outside
  React.useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  return (
    <div ref={containerRef} className="relative">
      <Button
        id={id}
        type="button"
        variant="outline"
        onClick={() => setOpen(!open)}
        className={cn(
          "w-full justify-start text-left font-normal h-9",
          !value && "text-muted-foreground"
        )}
      >
        <CalendarIcon className="mr-2 h-4 w-4" />
        {value ? format(selectedDate!, "PPP") : placeholder}
      </Button>
      {open && (
        <div className="absolute top-full left-0 z-50 mt-1 rounded-md border bg-popover p-3 shadow-md">
          <DayPicker
            mode="single"
            selected={selectedDate}
            onSelect={handleSelect}
            classNames={{
              months: "flex flex-col sm:flex-row gap-2",
              month: "flex flex-col gap-4",
              month_caption: "flex justify-center pt-1 relative items-center mb-2",
              caption_label: "text-sm font-medium",
              nav: "flex items-center gap-1 absolute right-0",
              button_previous: "h-7 w-7 bg-transparent p-0 opacity-50 hover:opacity-100 inline-flex items-center justify-center",
              button_next: "h-7 w-7 bg-transparent p-0 opacity-50 hover:opacity-100 inline-flex items-center justify-center",
              month_grid: "w-full border-collapse",
              weekdays: "flex",
              weekday: "text-muted-foreground rounded-md w-8 font-normal text-[0.8rem]",
              week: "flex w-full mt-2",
              day: "relative p-0 text-center text-sm focus-within:relative focus-within:z-20 [&:has([aria-selected])]:bg-accent [&:has([aria-selected].day-outside)]:bg-accent/50 [&:has([aria-selected].day-range-end)]:rounded-r-md",
              day_button: "h-8 w-8 p-0 font-normal aria-selected:opacity-100 hover:bg-accent hover:text-accent-foreground rounded-md inline-flex items-center justify-center",
              range_end: "day-range-end",
              selected: "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground rounded-md",
              today: "bg-accent text-accent-foreground",
              outside: "day-outside text-muted-foreground opacity-50",
              disabled: "text-muted-foreground opacity-50",
              hidden: "invisible",
            }}
          />
        </div>
      )}
    </div>
  )
}
