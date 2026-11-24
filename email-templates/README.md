# Yield Studio email templates

These are pasted by hand into the Supabase dashboard, at **Authentication → Emails → Templates**. The app never sends
emails itself and does not apply these templates. Supabase sends them.

| File | Paste into the Supabase template | Subject line |
|---|---|---|
| `sign_in_code.html` | **Magic link** (people who already have an account) | `Your Yield Studio code: {{ .Token }}` |
| `sign_in_code.html` | **Confirm signup** (first sign-in of a new address) | `Your Yield Studio code: {{ .Token }}` |
| `invite.html` | **Invite user** | `You're invited to Yield Studio` |

For each one, open the template, set the subject, replace the whole body with the file's contents, and save.

## Why both Magic link and Confirm signup

The sign-in page asks Supabase for a one-time code (`signInWithOtp`). Supabase uses **Confirm signup** the first time an
address signs in, and **Magic link** every time after that. Both must show `{{ .Token }}`, the one-time code (8 digits in this project). If a
template has only a link, people get a link instead of a code, and the app's code boxes cannot use it.

## Inviting someone

Go to **Authentication → Users → Add user → Send invitation** and enter an `@osu.edu` or `@buckeyemail.osu.edu` address.
The database refuses any other address. Supabase emails `invite.html`. The **Accept invitation** button
(`{{ .ConfirmationURL }}`) signs the person in once and opens the **Site URL**, where the app picks up the session and
goes to Explore. After that they sign in with emailed codes like everyone else.

Some university mail filters open links to scan them. That can use up the one-time invitation before the person
clicks it ("Token has expired or is invalid"). If that happens, they can simply sign in with their OSU email and a code;
the account already exists.

## Settings these templates rely on

| Where (Supabase dashboard) | Setting |
|---|---|
| Authentication → Sign In / Providers → Email | Email on. **Email OTP length**: this project uses 8; it must equal `VITE_OTP_LENGTH` in `frontend/.env.local` (restart with `./run.sh restart frontend` after changing it). **Email OTP expiration = 600** seconds (the templates say 10 minutes). |
| Authentication → URL Configuration | **Site URL** = where the website runs (`http://localhost:5173` now; the GitHub Pages address later, including `/AgSensing`). Add the same address under **Redirect URLs**. |
| Authentication → Emails → SMTP Settings | A real sender (OSU's SMTP, or a free plan such as Resend or Brevo). Supabase's built-in sender only emails members of your Supabase team, a few per hour. |

## Variables used

- `{{ .Token }}`: the one-time code (8 digits, set by Email OTP length).
- `{{ .Email }}`: the address the email is sent to.
- `{{ .ConfirmationURL }}`: the one-time invitation link that signs the person in.

The full list is in the Supabase docs under *Email Templates*.
