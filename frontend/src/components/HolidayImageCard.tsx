import { Image as ImageIcon, Maximize2, RefreshCw, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Banner, Card, CardTitle, Skeleton } from '@/components/ui/primitives';
import { prettyDate } from '@/lib/dates';
import { useDeleteHolidayImage, useHolidayImage, useUploadHolidayImage } from '@/lib/queries';

/** A picture of the holiday calendar (a photo or screenshot), kept in the account so it can be looked at any time. */
export function HolidayImageCard() {
  const q = useHolidayImage();
  const upload = useUploadHolidayImage();
  const remove = useDeleteHolidayImage();
  const input = useRef<HTMLInputElement>(null);
  const [viewOpen, setViewOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const meta = q.data?.exists ? q.data : null;
  const src = meta ? `/api/holidays/image/file?v=${encodeURIComponent(meta.updatedAt)}` : '';

  function pick(file: File | undefined) {
    if (input.current) input.current.value = ''; // so choosing the same file again still fires
    if (file) upload.mutate(file);
  }

  return (
    <Card>
      <CardTitle
        right={
          meta ? (
            <span className="num text-xs text-ink-soft">Updated {prettyDate(meta.updatedAt.slice(0, 10))}</span>
          ) : undefined
        }
      >
        Holiday calendar picture
      </CardTitle>

      <input ref={input} type="file" accept="image/*" className="sr-only" aria-label="Choose a picture" onChange={(e) => pick(e.target.files?.[0])} />

      {q.isLoading ? (
        <Skeleton className="h-24" />
      ) : q.isError ? (
        <Banner tone="bad">{q.error.message}</Banner>
      ) : meta ? (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setViewOpen(true)}
            aria-label="View the holiday calendar picture full size"
            className="overflow-hidden rounded-xl border border-line bg-muted focus-visible:outline-2 focus-visible:outline-primary"
          >
            <img src={src} alt="Your holiday calendar" loading="lazy" className="max-h-56 w-full object-contain" />
          </button>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setViewOpen(true)}>
              <Maximize2 size={16} aria-hidden /> View full size
            </Button>
            <Button size="sm" variant="outline" disabled={upload.isPending} onClick={() => input.current?.click()}>
              <RefreshCw size={16} aria-hidden /> {upload.isPending ? 'Uploading…' : 'Replace'}
            </Button>
            {confirmRemove ? (
              <>
                <Button size="sm" variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(undefined, { onSuccess: () => setConfirmRemove(false) })}>
                  {remove.isPending ? 'Removing…' : 'Yes, remove it'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
                  Keep it
                </Button>
              </>
            ) : (
              <Button size="sm" variant="destructiveText" onClick={() => setConfirmRemove(true)}>
                <Trash2 size={16} aria-hidden /> Remove
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-ink-soft">
            Keep a picture of your company&rsquo;s holiday calendar here, so you can look at it any time. Any photo or screenshot works.
          </p>
          <Button size="sm" variant="outline" disabled={upload.isPending} onClick={() => input.current?.click()}>
            {upload.isPending ? <RefreshCw size={16} className="animate-spin" aria-hidden /> : <Upload size={16} aria-hidden />}
            {upload.isPending ? 'Uploading…' : 'Upload a picture'}
          </Button>
        </div>
      )}

      {(upload.error || remove.error) && <Banner tone="bad" className="mt-3">{(upload.error ?? remove.error)!.message}</Banner>}
      <p className="mt-3 flex items-start gap-2 text-xs text-ink-soft">
        <ImageIcon size={14} className="mt-0.5 shrink-0" aria-hidden />
        <span>The picture is only for viewing. To fill in the holiday list, use &ldquo;Import from file&rdquo; or &ldquo;Add holiday&rdquo;.</span>
      </p>

      {meta && (
        <Dialog open={viewOpen} onOpenChange={setViewOpen} title="Holiday calendar" description={meta.fileName ?? undefined} className="md:max-w-4xl">
          <div className="max-h-[70vh] overflow-auto rounded-xl border border-line bg-muted">
            <img src={src} alt="Your holiday calendar, full size" width={meta.width} height={meta.height} className="mx-auto block h-auto max-w-none md:max-w-full" />
          </div>
        </Dialog>
      )}
    </Card>
  );
}
