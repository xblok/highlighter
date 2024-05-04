import { prepareEventsForTierPublish, publishToTiers } from "$actions/publishToTiers";
import { TierSelection } from "$lib/events/tiers";
import { DraftCheckpoint, DraftItem, ThreadCheckpoint, ThreadCheckpointItem } from "$stores/drafts";
import { ndk, newToasterMessage } from "@kind0/ui-common";
import NDK, { NDKEvent, NDKKind, NDKUser } from "@nostr-dev-kit/ndk";
import { Writable, get } from "svelte/store";

export type ThreadItem = {
    event: NDKEvent,
    urls: string[],
};

export class Thread {
    public items: ThreadItem[];
    private kind: NDKKind;
    private user: NDKUser;
    private ndk: NDK;

    constructor(kind: NDKKind, user: NDKUser, ndk: NDK) {
        this.kind = kind;
        this.items = [];
        this.user = user;
        this.ndk = ndk;

        this.newItem();
    }

    static deserialize(data: ThreadCheckpoint, user: NDKUser, ndk: NDK) {
        const thread = new Thread(NDKKind.Text, user, ndk);
        thread.items = data.items.map((i: ThreadCheckpointItem) => ({
            event: NDKEvent.deserialize(ndk, i.event),
            urls: i.urls
        }));
        thread.kind = thread.items[0]?.event.kind as NDKKind;

        // ensure all events have a random id
        thread.items.forEach(i => {
            if (!i.event.id) {
                i.event.id = Math.random().toString(36).substring(7);
            }
        });

        return thread;
    }

    public newItem() {
        const e = new NDKEvent(this.ndk);
        e.kind = this.kind;
        e.pubkey = this.user.pubkey;
        e.created_at = Math.floor(Date.now() / 1000);
        e.id = Math.random().toString(36).substring(7);
        this.items.push({ event: e, urls: [] });
    }

    public removeItem(i: number) {
        this.items.splice(i, 1);
    }

    public serialize(): ThreadCheckpoint {
        return {
            items: this.items.map(i => ({
                event: i.event.serialize(true, true),
                urls: i.urls
            }))
        }
    }
}

export function saveDraft(
    manuallySaved = false,
    draftItem: DraftItem | undefined,
    draftStore: Writable<DraftItem[]>,
    thread: Thread,
): DraftItem | false {
    const draftCheckpoints: DraftCheckpoint[] = draftItem?.checkpoints ? JSON.parse(draftItem?.checkpoints) : [];
    const serialized = thread.serialize();
    const checkpoint: DraftCheckpoint = {
        time: Date.now(),
        data: serialized,
        manuallySaved
    }

    if (draftItem) {
        const mostRecentCheckpoint = draftCheckpoints[0];
        // compare the data of the most recent checkpoint with the current data
        if (!manuallySaved && JSON.stringify(mostRecentCheckpoint.data) === JSON.stringify(serialized)) {
            return false;
        }

        draftStore.update((drafts) => drafts.filter(d => d.id !== draftItem!.id));
    } else {
        draftItem = {
            type: "thread",
            id: Math.random().toString(36).substring(7),
            checkpoints: "",
        }
    }

    draftCheckpoints.unshift(checkpoint);
    draftItem.checkpoints = JSON.stringify(draftCheckpoints);

    try {
        // unshift draftitem into the draft store
        draftStore.update((drafts) => [draftItem!, ...drafts]);
    } catch (e) {
        console.error(e);
    }

    return draftItem;
}

export async function publishThread(
    thread: Thread,
    publishAt?: Date,
    selectedTiers?: TierSelection,
) {
    const $ndk = get(ndk);
    let rootEvent: NDKEvent | undefined;
    let lastEvent: NDKEvent | undefined;
    let lastPublishTime: number;
    const timestampEventsEvery = 5; // seconds

    const kind1 = thread.items[0].event.kind === NDKKind.Text;

    // if publishAt is set, use it, in seconds
    if (publishAt) {
        lastPublishTime = Math.floor(publishAt.getTime() / 1000);
    } else {
        lastPublishTime = Math.floor(Date.now() / 1000); // now
    }

    for (const item of thread.items) {
        const event = item.event;
        event.id = "";
        event.sig = "";
        event.created_at = lastPublishTime;

        event.content = [event.content, ...item.urls].join("\n\n");

        // next publish time should be in timestampEventsEvery seconds
        lastPublishTime += timestampEventsEvery;

        if (rootEvent) {
            // tag the current event with the root event
            event.tag(rootEvent, "root", true);

            // if we have a lastEvent, tag it, we're replying to it since this is a thread
            if (lastEvent) { event.tag(lastEvent, "reply", true); }
        }

        let eventForPublish: NDKEvent | undefined;

        if (kind1) {
            eventForPublish = event;
        } else {
            eventForPublish = (await prepareEventsForTierPublish(
                event,
                selectedTiers,
                {
                    ndk: $ndk,
                    publishAt: publishAt,
                    explicitCreatedAt: event.created_at
                }
            ))[0]
        }

        if (!eventForPublish) {
            throw new Error("Failed to prepare event for publish");
        };

        // sign, we need Ids
        await eventForPublish.sign();
        eventForPublish.rawEvent();

        if (!rootEvent) {
            rootEvent = eventForPublish;
        } else {
            lastEvent = eventForPublish;
        }

        await publishToTiers(
            eventForPublish, {
                ndk: $ndk,
                publishAt: publishAt,
            }
        )
    }

    return rootEvent;
}