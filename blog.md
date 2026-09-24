# The problem

The problem is two fold primalry that we often fly, drive sail, sub, blimp in remote locations. This means that there is poor reception this mens that if we want to use the wiki here we need to hotsopt this not the end of the worurld but in common usecases we often need to connect laptop a LAN that is not the Phones acess point. This is VERRY anlying as switching is time consumeing and painfull! This catosropicly degrades the UX of workig on the progect. The seccond isue is that the wiki is slow not unmanagably slow about 1000 ms this is not that bad for a normal usere but to have to wait 1s for a page to load is verry fustrating. 




- The wiki is SLOW!!!
- The dispite a large amount of my and the comuintys flying, driving, sailing, subing, blinping being remote will limited reception

When you are debuging a vehicle out in the field under the hot sun or frezzing wind beging your phone's hotsopt to load quicker before your vtx drains your battery. This is a situation that I have personaly never found my self as I always read the docs and do the confuation on the bench :). But a friend told me that this happend to them once.

?????????
So to slove this I decided trying to aply what I learned in my year 12 sofwhere corse a PWA this Progresive Web App this is a way of baciclay 
?????????

# The solution

To solve this I can implmet a PWA this is a piece of new web magic this will let you many things but relevent to us it enablse a websit to work off like buy intercepting your web requests with java script.
So my mentel modle for how this works is as follows.
There is a somthing called a service worker (SW) in a sw.js file. NOTE: this is ristricted to be only served with https:// and localhost:// NOT http:// (otherwise a bad actor could spoof then give you bad SW this could let them pull from there origin while appering to be on the website that you are on).
This service worker will allow the nomal js/html to on the site to send requests nomaly so for example if lest say `fetch ardupilot.org/index.html` this can be called by nomal js or html then the sw will intercept this request then it can do what ever you want it to do.
For example this could include say fetching that 
1. Fetching this from cashe then validateing it aysrously (this is what offline wiki does)
2. Just showing you the cashe and not validating and trust on cashe expiry
3. There are amlost endless other possableiys and I don't know them all

This mentel model dispite being usfull and cool but it will help you undstand how this works better.

So fist I needed some way to fill up the cashe without DoSing (this is where you send so mannu requests that the server dies under the load). If I wrote some JS to just scan recursivly download each page manualy it would work for me but if i scaled this we would 100% go down and it would be unstopable as a issue I have had in previous progects where a bad SW would not allow updates this mend that I had to hard reload the browser and on IOS it was a even bigger pain. But if this was to happen on the wiki we would have caused a unstopable DoS atack amusing if it happend to someone else but a really bad day for us all if it happend to us.
So to do this I made sure that I made it to regually check that there was a new SW and if there was it would update its self. I made a second SW that can be droped in to place of the first and this `kill-switch.js` will deleate the cashe. This was a last resort incase of a catosropic flalier. 
So to fix this self DoS I fist had to bundle the whole wiki in to a single compresed blob and send it to the user. So there were some optimations that I did ...
- One bundle per wiki
- The comon wiki is conciderd its own vercal
- Pramater compresion 
    I needed to find a effcent way to copress +700mb of pramates down to under 20mb so that I could simplifi the UI and also have them all there as this makes the product more complete. One of the biggest tricks wilth compresion alrythons is to pic one that suits your data. My data is html but more impotalny mulable nealy identical html files. There is a varry minmal amount of diffrence between each vertion so this ment the I needed to pick a compresion alrythome that can leavrage this. I new this type of agrytom was out there as it is a verry common uase case such as differancahl bacups. After some reashearch I found zstd this compresion algrythm is used by Arch luinx to compress its pacages because dispite it having slighly worse compression ratio then .gz it is 16x faster this suits the goals of this progect well. But more impotalny it has the abliy to do patch from 
    https://github.com/facebook/zstd/wiki/Zstandard-as-a-patching-engine
    This site goes in to the details but it is sopira in almost evlry way. By using the the python liberry equvelnt to --patch-form flag this allow the size of the archve for all pramaters to go from xxxxx to 2.8 mb for all vertions from 4.0 to present day on all vercals sub, rover, blim, plane, copter ... . This mealy 10mb now can be distrubuted effcently and included to the large tars by default. This has conciderable beinift. 

Now I had the backend worked out it was time to do the fount end. This is where I had to make it noninvase and also intuitive to use. I chose to add the offline to the banner as it is part of the nomal wiki. I also made that page be a normal sphinx (the exiting wiki liberry to build) page then it pulled in the js but the CSS and the html was all standers sphinx this increases the maintablity. 
In adtion to this I added a page to the dev wiki this contains how it works so that anyone maintaingin it can learn how this works before making changes to it. I have also inclued some more tecnical details in there there that go in to greater depth then here https://ardupilot.org/dev/docs/wiki-offline-copies.html .

# Limitaion/futher work
There is duplication of the common wikis html this html is saved with duplication this is bad not the bese desgin as it will mean that if there is a update pused to common pages and you have all the wikis downloaded there as is currentl is you will need to download the same common file up to 10x this is not that iniffcent as the images for common wikis are all cashed so it is just the html. 
At the moment there the amount of storage that is used is primalry used for images there are som verry large images these are taking up a lot of space about 400 mb this can be reduesed but doing a traul now to rencode all the images then as new PR come in to keep them at a resonbal size. We have allready make a github action that will enfoce this.






