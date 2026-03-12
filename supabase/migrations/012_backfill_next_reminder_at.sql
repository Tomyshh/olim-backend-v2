-- Backfill next_reminder_at on leads from lead_reminders (earliest future non-treated reminder)
UPDATE public.leads l
SET next_reminder_at = sub.next_at
FROM (
  SELECT DISTINCT ON (lead_id) lead_id, reminder_at AS next_at
  FROM public.lead_reminders
  WHERE treated = false AND reminder_at > now()
  ORDER BY lead_id, reminder_at ASC
) sub
WHERE l.id = sub.lead_id;
