All three searches are done. Before I write the summary I'm checking the two claims that matter most myself: that Hetzner isn't taking new customers for cloud servers, and the price of OVH's new VPS range.

Confirmed: Hetzner is restricting new cloud servers for new customers, since 26 June. Now the OVH prices.

You're right that I should have found Leaseweb myself. My searches started from the names you gave me and from comparison sites that only cover a limited set of companies. This time the search started from independent rankings (VPSBenchmarks), the community, and the bare-metal market. It found companies we hadn't discussed, and it corrected some of what I told you before.

## Corrections to what I said earlier

- **Hetzner is not taking new customers for cloud servers right now.** I opened their status page myself: since 26 June 2026 they've been restricting new cloud servers for new customers, and for some existing customers picked at random. So CX33 and CCX23 are probably not orderable for you, even though I listed them as options.
- **netcup's dedicated cores aren't as solid as I made them sound.**
  - VPSBenchmarks graded its performance stability **D** in July 2026, and single-core results vary up to 1.4× between servers.
  - In 2024 there was a big controversy when "dedicated" cores were throttled by about 50%.
  - Existing contracts went up 18.5% in May 2026.
  - It's still the best value in its category, but you need to test it during the 30-day refund window.
- **Leaseweb's €8.09 is the 1-year commitment price.** Month-to-month is €8.99.

## First: shared servers (VPS)

Prices exclude VAT.

| #   | Provider and plan                | Specs                 | Monthly price                | Single / multi-core (GB6) | Notes                                                                                                         |
| --- | -------------------------------- | --------------------- | ---------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | **OVHcloud VPS-2 (2027 range)**  | 4 vCPU / 8GB / 75GB   | **€7.21** (monthly ~€8.49)   | ~1,590 / 5,140            | Large listed French company. Daily backup and unlimited traffic included. **Stability A** in benchmark trials |
| 1   | **OVHcloud VPS-4**               | 8 vCPU / 24GB / 200GB | **€19.96**                   | ~1,630 / 8,530            | Same as above                                                                                                 |
| 2   | **netcup VPS 1000 / 2000 G12.5** | 4/8/128 · 8/16/256    | €12.18 / €22.62              | ~1,500–2,000              | Strong CPU. Support slow, account setup can be slow                                                           |
| 3   | **Leaseweb VPS 2 / 3**           | 6/16/200 · 8/24/300   | €8.99 / €13.99               | ~1,050–1,230              | Lots of RAM, weak single-core, stability C                                                                    |
| 4   | IONOS VPS L+ / XL+               | 4/8/240 · 8/16/480    | Intro price, renewal unclear | ~2,175 / 6,510            | Strong CPU, but the post-intro price isn't stated                                                             |

- **OVH notes:** I checked their prices myself. Avoid "Local Zone" locations, because they run old processors. Some customers report identity checks or refused orders, including one case that looked tied to residency, so open the account and get it verified before you need the server.
- **The best overall:** **OVH is the new name that tops this category** for price and stability together.
- **Not recommended:**
  - **Hostinger:** trial stability D and score 44.
  - **one.com:** no data at all.
  - **Contabo:** ongoing problems, plus a storage-slowdown warning on their own status page open for 49 days.
  - **Alwyzon:** the strongest CPU of all (~2,510 single-core), but it's a one-person company with a single data center.

## Second: dedicated-core servers (VPS / VDS)

| #   | Provider and plan               | Specs              | Monthly price       | Notes                                                                            |
| --- | ------------------------------- | ------------------ | ------------------- | -------------------------------------------------------------------------------- |
| 1   | **netcup RS 1000 / 2000 G12.5** | 4/8/128 · 8/16/256 | **€18.26 / €34.20** | Best value by a wide margin. Stability needs testing (see the corrections above) |
| 2   | OVHcloud c3-8 (Public Cloud)    | 4 dedicated / 8GB  | ~€79                | Stability A, but more than double netcup's price                                 |
| 3   | Hetzner CCX23                   | 4 dedicated / 16GB | €86.49              | Probably not orderable for a new customer                                        |

- **Rest of the field:** Cherry Servers, Avoro, Scaleway, DigitalOcean and Akamai are 2–4× more expensive with no clear advantage. Several companies that sell "dedicated" cores turned out to be shared when tested: 0ping, OnetSolutions, Alwyzon, Euronodes.
- **A general note:** "dedicated core" almost everywhere means **one dedicated thread**, not a full physical core.

## Third: full physical servers (bare metal)

This category was missing from my earlier answers, and it gives the most raw performance per euro:

| #   | Server           | Specs                                                       | Monthly price                                       | Notes                                                                                    |
| --- | ---------------- | ----------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | **OVH Rise-S**   | Ryzen 7 9700X, 8 cores / 16 threads, **64GB**, 2×512GB NVMe | **€65.54** (€62.26 prepaid 12 months, no setup fee) | Single-core ~3,500, about **1.5× netcup**. Currently only in stock in Gravelines, France |
| 2   | **Hetzner EX44** | i5-13500, 14 cores, **64GB**, 2×512GB NVMe                  | **€59**, no setup fee or contract                   | No ECC RAM                                                                               |
| 3   | Hetzner AX42-1   | Ryzen 7 PRO 8700GE, 64GB ECC (verify)                       | €99 + €49 setup                                     | For ECC RAM. Performance only slightly above netcup                                      |

**What you give up with a physical server:**

- No snapshots, and the server can't be moved to another host if the hardware fails.
- You set up RAID 1 for the disks yourself and monitor it.
- A disk or motherboard failure means **hours** of downtime, not minutes.

## My recommendation

- **Small projects (sites, staging, light apps):** **OVH VPS-2** at €7.21, or **VPS-4** at €19.96 if you need more resources.
- **Medium production apps:** **OVH VPS-4**, or **netcup VPS 2000**.
- **soft-house-dash-4:** **netcup RS 2000** at €34.20.
  - Use the 30-day refund window to test it: CPU stability under sustained load, steal time, and how much results vary.
  - If it fails the test, or you need more power later, the next step up is **OVH Rise-S** at about €62–66 rather than paying more for dedicated cores elsewhere. You get 1.5× the speed and 4× the RAM, but you take on running a physical server yourself.

**Sources:**

- [Hetzner status – limited cloud availability](https://status.hetzner.com/incident/0a75c7ae-3377-41dc-aabe-601063724d24)
- [Hetzner price adjustment (official)](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/)
- [Hetzner EX44](https://www.hetzner.com/dedicated-rootserver/ex44/)
- [Hetzner AX42](https://www.hetzner.com/dedicated-rootserver/ax42/)
- [OVHcloud VPS (official)](https://www.ovhcloud.com/en-ie/vps/)
- [OVH VPS-4 trial – Sep 2026](https://www.vpsbenchmarks.com/trials/ovhcloud_performance_trial_07Sep2026)
- [OVH VPS-1 2026 yabs – Frankfurt](https://www.vpsbenchmarks.com/yabs/ovhcloud-4c-8gb-20260606-tg10206)
- [OVH Public Cloud pricing update Oct 2026](https://blog.ovhcloud.com/en/posts/public-cloud-pricing-update-october-2026/)
- [OVH Eco catalog (Rise)](https://eu.api.ovh.com/v1/order/catalog/public/eco?ovhSubsidiary=DE)
- [OVH Rise-S class yabs](https://vpsbenchmarks.com/yabs/ovhcloud-16c-62gb-20250107-ee3fbc)
- [netcup Root Server (official)](https://www.netcup.com/en/server/root-server)
- [netcup VPS (official)](https://www.netcup.com/en/server/vps)
- [netcup RS trial – Jul 2026](https://www.vpsbenchmarks.com/trials/netcup_performance_trial_23Jul2026)
- [netcup dedicated-core throttling (2024) – LowEndBox](https://lowendbox.com/blog/netcup-faces-user-riot-over-throttling-supposedly-dedicated-cores)
- [Leaseweb VPS trial – Aug 2026](https://www.vpsbenchmarks.com/trials/leaseweb_performance_trial_11Aug2026)
- [IONOS VPS L+ trial – Sep 2026](https://www.vpsbenchmarks.com/trials/ionos_performance_trial_24Sep2026)
- [Alwyzon trial – Aug 2026](https://www.vpsbenchmarks.com/trials/alwyzon_performance_trial_24Aug2026)
- [Hostinger trial – Aug 2026](https://www.vpsbenchmarks.com/trials/hostinger_performance_trial_26Aug2026)
- [Contabo status reports – StatusGator](https://statusgator.com/services/contabo)
- [OVHcloud Trustpilot](https://www.trustpilot.com/review/ovhcloud.com?sort=recency)
- [netcup Trustpilot](https://www.trustpilot.com/review/netcup.com?sort=recency)
