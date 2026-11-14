/* Based on DiscordBotClient by aiko-chan-ai (GPL-3.0). Modified for BotDeck. */

import { APIMessage, MessageType } from "discord-api-types/v10";
import Constants from "src/AppCore/Constants";

// Local-only welcome message: no external images, links or sponsor content.
export async function GetSystemMessage () {
    return [
        {
            id: "1000000000000000000",
            type: 47 as MessageType,
            channel_id: Constants.ChannelIdDefault,
            author: Constants.UserDefaultPatch,
            attachments: [],
            content: "",
            embeds: [
                {
                    type: "rich",
                    title: "BotDeck",
                    description:
                        "Your bot, in a Discord-style client.\n\nBotDeck is free software (GPL-3.0), based on DiscordBotClient by aiko-chan-ai. " +
                        "Only install builds you obtained from a source you trust, and never share your bot token.",
                    color: 5793266,
                },
            ],
            mentions: [],
            mention_roles: [],
            pinned: false,
            mention_everyone: false,
            tts: false,
            timestamp: new Date().toISOString(),
            edited_timestamp: null,
            flags: 16,
            components: [],
        },
    ] as APIMessage[];
}
