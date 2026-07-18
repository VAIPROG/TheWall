import { BackendClient } from "./client";
import { BackendUser } from "./types";

/** Body for PATCH /api/v3/users/me — mirrors backend `UserUpdate`
 *  (backend/src/models/users.rs, camelCase serde). Note: freeform social
 *  links are NOT part of this surface; they still ride the V2 profile
 *  endpoint (see legacy.updateProfileV2). */
export interface ProfileUpdate {
  displayName?: string;
  username?: string;
  bio?: string;
  lang?: string;
  telemetryOptIn?: boolean;
}

export function buildUsersApi(client: BackendClient) {
  const path = (ref: string) => `/users/${encodeURIComponent(ref)}`;

  return {
    me: () => client.get<BackendUser>("/users/me"),

    get: (ref: string) => client.get<BackendUser>(path(ref)),

    updateMe: (body: ProfileUpdate) => client.patch<BackendUser>("/users/me", body),

    // Avatar upload + self-delete still use the V1 root endpoints. V3's
    // avatar upload is multipart/form-data (POST /api/v3/users/me/avatar);
    // BackendClient only speaks JSON bodies, so switching needs a multipart
    // wrapper first. TODO(phase3): switch setAvatar to the V3 multipart upload.
    avatar: () => client.getRoot<string>("/me/avatar"),

    setAvatar: (image: string) => client.putRoot("/me/avatar", { image }),

    /** Remove the custom avatar (falls back to Discord → identicon chain).
     *  V3: DELETE /api/v3/users/me/avatar. */
    deleteAvatar: () => client.delete("/users/me/avatar"),

    deleteMe: (reason?: string) =>
      client.postRoot("/me/delete", { confirm: true, reason }),
  };
}
