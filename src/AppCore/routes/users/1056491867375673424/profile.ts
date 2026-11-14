/* Copyright Elysia © 2025. All rights reserved */

import { Router } from "express";
import Constants from "src/AppCore/Constants";
import Util from "src/AppUtils/Utils";

const app = Router({ mergeParams: true });

app.get("/", (req, res) => {
    res.send(
        Util.ProfilePatch(
            Constants.UserDefaultPatch,
            null,
            null,
            "BotDeck",
        ),
    );
});

export default app;
