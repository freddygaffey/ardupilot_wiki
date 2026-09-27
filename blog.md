# The problem

The problem is two fold primarily that we often fly, drive, sail, sub, blimp in remote locations. This means that there is poor reception this means that if we want to use the wiki here we need to hotspot this not the end of the world but in common use cases we often need to connect a laptop to a LAN that is not the phone's access point. This is VERY annoying as switching is time consuming and painful! This catastrophically degrades the UX of working on the project. The second issue is that the wiki is slow not unmanageably slow about 1000 ms this is not that bad for a normal user but to have to wait 1s for a page to load is very frustrating. This is not good enough modern web can comfortably have less than 100ms and we should be asking more from our technology.

When you are debugging a vehicle out in the field under the hot sun or freezing wind begging your phone's hotspot to load quicker before your VTX drains your battery. This is a situation that I have personally never found myself as I always read the docs and do the configuration on the bench :). But a friend told me that this happened to them once.

?????????
So to solve this I decided trying to apply what I learned in my year 12 software course a PWA this Progressive Web App this is a way of basically 
?????????

# The solution

To solve this I can implement a PWA this is a piece of new web magic this will let you many things but relevant to us it enables a website to work offline by intercepting your web requests with JavaScript.
So my mental model for how this works is as follows.
There is something called a service worker (SW) in a sw.js file. NOTE: this is restricted to be only served with https:// and localhost:// NOT http:// (otherwise a bad actor could spoof then give you bad SW this could let them pull from their origin while appearing to be on the website that you are on).
This service worker will allow the normal js/html on the site to send requests normally so for example if let's say `fetch ardupilot.org/index.html` this can be called by normal js or html then the sw will intercept this request then it can do what ever you want it to do.
For example this could include say fetching that 
1. Fetching this from cache then validating it asynchronously (this is what offline wiki does)
2. Just showing you the cache and not validating and trust on cache expiry
3. There are almost endless other possibilities and I don't know them all

This mental model despite being useful and cool but it will help you understand how this works better.

So first I needed some way to fill up the cache without DoSing (this is where you send so many requests that the server dies under the load). If I wrote some JS to just scan recursively download each page manually it would work for me but if I scaled this we would 100% go down and it would be unstoppable as an issue I have had in previous projects where a bad SW would not allow updates this meant that I had to hard reload the browser and on iOS it was an even bigger pain. But if this was to happen on the wiki we would have caused an unstoppable DoS attack amusing if it happened to someone else but a really bad day for us all if it happened to us.
So to do this I made sure that I made it to regularly check that there was a new SW and if there was it would update itself. I made a second SW that can be dropped in to place of the first and this `kill-switch.js` will delete the cache. This was a last resort in case of a catastrophic failure. 
So to fix this self DoS I first had to bundle the whole wiki in to a single compressed blob and send it to the user. So there were some optimisations that I did ...
- One bundle per wiki
- The common wiki is considered its own vertical
- Parameter compression 
    I needed to find an efficient way to compress +700mb of parameters down to under 20mb so that I could simplify the UI and also have them all there as this makes the product more complete. One of the biggest tricks with compression algorithms is to pick one that suits your data. My data is html but more importantly multiple nearly identical html files. There is a very minimal amount of difference between each version so this meant that I needed to pick a compression algorithm that can leverage this. I knew this type of algorithm was out there as it is a very common use case such as differential backups. After some research I found zstd this compression algorithm is used by Arch Linux to compress its packages because despite it having slightly worse compression ratio than .gz it is 16x faster this suits the goals of this project well. But more importantly it has the ability to do patch from 
    https://github.com/facebook/zstd/wiki/Zstandard-as-a-patching-engine
    This site goes into the details but it is superior in almost every way. By using the python library equivalent to --patch-from flag this allows the size of the archive for all parameters to go from xxxxx to 2.8 mb for all versions from 4.0 to present day on all verticals sub, rover, blimp, plane, copter ... . This measly 10mb now can be distributed efficiently and included to the large tars by default. This has considerable benefit. 

Now I had the backend worked out it was time to do the front end. This is where I had to make it non-invasive and also intuitive to use. I chose to add the offline to the banner as it is part of the normal wiki. I also made that page be a normal Sphinx (the existing wiki library to build) page then it pulled in the js but the CSS and the html was all standard Sphinx this increases the maintainability. 
In addition to this I added a page to the dev wiki this contains how it works so that anyone maintaining it can learn how this works before making changes to it. I have also included some more technical details in there that go into greater depth than here https://ardupilot.org/dev/docs/wiki-offline-copies.html .

# Limitations/further work
There is duplication of the common wiki's html this html is saved with duplication this is bad not the best design as it will mean that if there is an update pushed to common pages and you have all the wikis downloaded as it currently is you will need to download the same common file up to 10x this is not that inefficient as the images for common wikis are all cached so it is just the html. 
At the moment the amount of storage that is used is primarily used for images there are some very large images these are taking up a lot of space about 400 mb this can be reduced by doing a trawl now to re-encode all the images then as new PRs come in to keep them at a reasonable size. We have already made a github action that will enforce this.
