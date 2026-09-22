# The problem

- The wiki is SLOW!!!
- The dispite a large amount of the flying being remote will limited reception

When you are debuging a vercal out at the flying field in the hot sun beging your phone hotsopt to load quicker before your vtx drains your battery. This is a situation that I have personaly never found my self if but I heard of it from a friend wink wink. That friend tells me how horable that is. 

?????????
So to slove this I decided trying to aply what I learned in my year 12 sofwhere corse a PWA this Portable Web App this is a way of baciclay 
?????????

# The solution

To do this I can implmet a PWA this is a piece of new web magic this will let you many things primraly intercept your web requests with java script. So my mentel modle for how this works is as follows.
There is a somthing called a servirece worker SW in a sw.js file this is ristricted to be only served with https:// NOT http:// (otherwise a bad actor could spoof then give you bad SW this could let them pul from there ogigin not while apering to be on the website that you are on).
This service worker will allow the nomal js/html to on the site to send requests nomaly so for example if lest say `fetch ardupilot.org/index.html` this can be called by nomal js or html then the sw will intercept this request then it can do what ever you want it to do.
1. This could include say fetching that imidatly
2. Fetching this from cashe then validateing it aysrously (this is what offline wiki does)
3. Just showing you the cashe and not validating and trust on cashe expiry
4. There are amlost endless other possableiys and I don't know them all

This mentel model dispite being usfull and cool but it will help you undstand how this works better.

So fist i needed some way to fill up the cashe without DoSing (this is where you send so mannu requests that the server dies under the load). If I wrote some JS to just scan recursivly download each page manualy it would work for me but if i scaled this we would 100% go down and it would be unstopable as a issue I have had in previous progects where a bad SW would not allow updates this mend that I had to hard reload the browser and on IOS it was a even bigger pain. But if this was to happen on the wiki we would have caused a unstopable DoS atack amusing if it happend to someone else but a really bad day for us all if it happend to us.
So to do this I made sure that I made it to regually check that there was a new SW and if there was it would update its self. I made a second SW that can be droped in to place of the first and this `kill-switch.js` will deleate the cashe. This was a last resort incase of a catosropic flalier. 
So to fix this self DoS I fist had to bundle the whole wiki in to a single compresed blob and send it to the user. So there were some optimations that I did ...
- One bundle per wiki
- The comon wiki is conciderd its own vercal
- Pramater compresion 
    I needed to find a effcent way to copress +700mb of pramates down to under 20mb so that I could simplifi the UI and also have them all there as this makes the product more complete. One of the biggest tricks wilth compresion alrythons is to pic one that suits your data. My data is html but more impotalny mulable nealy identical html files. There is a varry minmal amount of diffrence between each vertion so this ment the I needed to pick a compresion alrythome that can leavrage this. I new this type of agrytom was out there as it is a verry common uase case such as differancahl bacups. After some reashearch I found zstd this compresion algrythm is used by Arch luinx to compress its pacages because dispite it having slighly worse compression ratio then .gz it is 16x faster this suits the goals of this progect well. But more impotalny it has the abliy to do patch from 
    https://github.com/facebook/zstd/wiki/Zstandard-as-a-patching-engine
    This site goes in to the details but it is sopira in almost evlry way. By using the --patch-form flag this allow the size of the archve for all pramaters to go from xxxxx to 10 mb for all vertions from 3.9.x to present day on all vercals sub, rover, blim, plane, copter ... . This mealy 10mb now can be distrubuted effcently and included to the large tars by default. This has conciderable beinift. 






Unfutonaly i cant make this to tecnical so this is the full how this works artical on the ardupilo dev wiki https://ardupilot.org/dev/docs/wiki-offline-copies.html









